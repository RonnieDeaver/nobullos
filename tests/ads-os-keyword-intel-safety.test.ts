/* test-registration
{
  "name": "Ads OS keyword-intel safety filter — tokenize/stem, protected words+geo builders, formatNegative, negative-match simulator (broad/phrase/exact, no close variants), enforceSafety floors+downgrade, dedupeNegatives, prompt verbatim sentinels (Task #3600)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3600: Ads OS Search Term Analyzer deterministic safety filter — the protected-word/geo enforcement, asymmetric confidence floors + broad-> phrase downgrade, dedupe, and the negative-match simulator that powers both the converting-term caution and the cross-tool held-back flow. Pure functions + a source-text prompt-fidelity check, DB-free, fast; a drift here can suggest negatives that block a firm's own client traffic.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "scanPaths": [
    "server/services/adsOs/keywordIntel/suggest.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 4 — Search Term Analyzer deterministic safety filter, pure unit
 * tests (Task #3600).
 *
 * Guards the pieces ported verbatim from the bundle's
 * backend/app/keyword_intel/safety.py + prompts:
 *   (a) tokenizing + stemming (plural/possessive fold, double-s and 2-letter
 *       state guards) and the protected-set builders — protected words are
 *       stem-aware, website brand tokens drop the TLD/short labels, geo
 *       expands US state abbreviation <-> full name (DC -> washington);
 *   (b) formatNegative paste-ready shapes (broad plain, "phrase", [exact]);
 *   (c) negativeBlocks — the negative-match simulator behind both the
 *       converting-term caution and the cross-tool held-back flow: broad
 *       any-order, phrase contiguous in-order, exact identical, NO close
 *       variants (exact word forms, 1-char tokens kept);
 *   (d) enforceSafety — per-negative gating: protected-word/geo enforcement
 *       (broad = ANY word protected drops; phrase/exact = ALL words protected
 *       drops), asymmetric confidence floors (broad >= 0.8, else DOWNGRADE to
 *       a phrase of the whole term; phrase/exact >= 0.6, or >= 0.45 for the
 *       soft informational/job_seeker categories), hallucinated-term drop,
 *       whole-term-protected downgrade guard;
 *   (e) dedupeNegatives — same negative across terms collapses to one row
 *       (summed metrics, max confidence, highest-cost representative,
 *       covers-N note), output sorted highest cost first;
 *   (f) prompt fidelity — the reason-first system prompt and user-prompt
 *       scaffolding sentinels stay verbatim in suggest.ts.
 *
 * DB-free, network-free (pure functions + a source-text check).
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  US_STATES,
  brandTokensFromWebsite,
  buildGeoProtected,
  buildProtectedWords,
  dedupeNegatives,
  enforceSafety,
  formatNegative,
  merge,
  negativeBlocks,
  stem,
  tokenize,
} = await import("../server/services/adsOs/keywordIntel/safety");
type SearchTermRowT = import("../server/services/adsOs/keywordIntel/queries").SearchTermRow;

const FLOORS = { broadMinConf: 0.8, defaultMinConf: 0.6, softMinConf: 0.45 };

function row(term: string, over: Partial<SearchTermRowT> = {}): SearchTermRowT {
  return {
    search_term: term,
    campaign: "Camp A",
    ad_group: "AG 1",
    matched_keyword: "kw",
    impressions: 100,
    clicks: 10,
    cost: 25,
    conversions: 0,
    avg_cpc: 2.5,
    cost_per_conv: 0,
    campaign_id: "c1",
    ...over,
  };
}

function byTerm(...rows: SearchTermRowT[]): Map<string, SearchTermRowT> {
  return new Map(rows.map((r) => [r.search_term, r]));
}

// ── (a) tokenize + stem + protected-set builders ──
{
  assert.deepEqual(tokenize('“Cheap” [Lawyer]s + DUI, a 7'), ["cheap", "lawyer", "dui"],
    "tokenize lowercases, strips symbols/punctuation, drops 1-char tokens");
  assert.equal(stem("lawyers"), "lawyer", "simple plural folds");
  assert.equal(stem("business"), "business", "double-s never folds");
  assert.equal(stem("class"), "class", "double-s never folds (class)");
  assert.equal(stem("gas"), "gas", "len-3 words never fold");
  assert.equal(stem("md"), "md", "2-letter state abbreviations never fold");

  const words = buildProtectedWords(
    "Smith & Jones Law",           // business name
    "estate planning, wills",      // services offered
    "probate",                     // extra protected terms
    ["divorce lawyers near me"],   // active keywords (plural on purpose)
    ["Family Law"],                // practice areas
  );
  for (const w of ["smith", "jone", "law", "estate", "planning", "will", "probate", "divorce", "lawyer", "near", "me", "family"]) {
    assert.ok(words.has(w), `protected words include stem "${w}"`);
  }
  assert.ok(!words.has("lawyers"), "stored stem-folded (lawyers -> lawyer)");

  assert.deepEqual([...brandTokensFromWebsite("https://www.smith-law.com/contact?x=1")].sort(),
    ["law", "smith"], "website brand tokens: scheme/www/path stripped, TLD dropped");
  assert.deepEqual([...brandTokensFromWebsite("chesapeakeplumbing.co.uk")].sort(),
    ["chesapeakeplumbing"], "short labels (co, uk) skipped");
  assert.equal(brandTokensFromWebsite("").size, 0, "blank website -> empty set");

  const geo = buildGeoProtected("Baltimore and Annapolis, MD");
  for (const w of ["baltimore", "annapoli", "md", "maryland"]) {
    assert.ok(geo.has(w), `geo protected includes "${w}" (state abbr expands to full name)`);
  }
  const geo2 = buildGeoProtected("serving all of Maryland");
  assert.ok(geo2.has("md"), "full state name expands back to the abbreviation");
  const dc = buildGeoProtected("Washington DC metro");
  assert.ok(dc.has("washington") && dc.has("dc"), "DC also shields washington");
  assert.equal(Object.keys(US_STATES).length, 51, "50 states + DC");

  assert.deepEqual([...merge(new Set(["a"]), new Set(["b", "a"]))].sort(), ["a", "b"]);
}

// ── (b) formatNegative paste-ready shapes ──
{
  assert.equal(formatNegative("cheap", "broad"), "cheap");
  assert.equal(formatNegative("cheap lawyer", "phrase"), '"cheap lawyer"');
  assert.equal(formatNegative("cheap lawyer", "exact"), "[cheap lawyer]");
  assert.equal(formatNegative("  padded  ", "broad"), "padded", "trimmed");
}

// ── (c) negativeBlocks — the negative-match simulator ──
{
  // broad: every negative word present, any order
  assert.ok(negativeBlocks("lawyer cheap", "broad", "cheap divorce lawyer"), "broad any-order");
  assert.ok(!negativeBlocks("cheap lawyer", "broad", "cheap attorney"), "broad needs every word");
  // phrase: contiguous, in order
  assert.ok(negativeBlocks("cheap lawyer", "phrase", "very cheap lawyer near me"), "phrase contiguous");
  assert.ok(!negativeBlocks("cheap lawyer", "phrase", "cheap divorce lawyer"), "phrase non-contiguous no block");
  // exact: identical term only
  assert.ok(negativeBlocks("cheap lawyer", "exact", "Cheap  Lawyer"), "exact = same words (case/space folded)");
  assert.ok(!negativeBlocks("cheap lawyer", "exact", "cheap lawyer near me"), "exact blocks nothing longer");
  // NO close variants: exact word forms, no stemming
  assert.ok(!negativeBlocks("lawyer", "broad", "lawyers in annapolis"), "no plural expansion (Google negatives don't close-variant)");
  // 1-char tokens kept — chapter 7 vs chapter 9 must differ
  assert.ok(negativeBlocks("chapter 7 bankruptcy", "phrase", "file chapter 7 bankruptcy online"));
  assert.ok(!negativeBlocks("chapter 7 bankruptcy", "phrase", "file chapter 9 bankruptcy online"),
    "1-char tokens kept: chapter 7 != chapter 9");
  // paste-ready symbols stripped from the negative text
  assert.ok(negativeBlocks('"cheap lawyer"', "phrase", "cheap lawyer dc"), "quotes stripped");
  assert.ok(negativeBlocks("[cheap lawyer]", "exact", "cheap lawyer"), "brackets stripped");
  // unknown match type defaults to phrase semantics (safe)
  assert.ok(negativeBlocks("cheap lawyer", "weird", "a cheap lawyer here"));
  assert.ok(!negativeBlocks("", "broad", "anything"), "empty negative never blocks");
}

// ── (d) enforceSafety — protected enforcement + asymmetric confidence floors ──
{
  const protectedAll = merge(
    buildProtectedWords("Smith Law", "personal injury", "", ["injury lawyer"], []),
    buildGeoProtected("Annapolis, MD"),
  );
  const t1 = row("injury lawyer jobs", { cost: 30 });
  const t2 = row("diy accident claim forms", { cost: 20 });
  const t3 = row("personal injury lawyer", { cost: 10 });

  const out = enforceSafety(
    [
      {
        search_term: "injury lawyer jobs",
        category: "job_seeker",
        reason: "employment intent",
        negatives: [
          { text: "jobs", match_type: "broad", confidence: 0.9 },      // kept broad (>= 0.8)
          { text: "lawyer", match_type: "broad", confidence: 0.95 },   // protected word -> dropped
          { text: "maryland", match_type: "broad", confidence: 0.9 },  // protected geo (via MD) -> dropped
        ],
      },
      {
        search_term: "diy accident claim forms",
        category: "wrong_intent",
        reason: "not hiring a lawyer",
        negatives: [
          { text: "diy", match_type: "broad", confidence: 0.7 },       // broad below 0.8, >= 0.6 -> DOWNGRADED
          { text: "forms", match_type: "broad", confidence: 0.5 },     // below phrase floor too -> dropped
        ],
      },
      {
        search_term: "personal injury lawyer",
        category: "other",
        reason: "whole term protected",
        // all words protected -> phrase dropped; and the broad downgrade guard
        negatives: [
          { text: "personal injury lawyer", match_type: "phrase", confidence: 0.9 },
          { text: "personal", match_type: "broad", confidence: 0.7 },
        ],
      },
      {
        search_term: "hallucinated term",
        category: "other",
        reason: "model made this up",
        negatives: [{ text: "hallucinated", match_type: "broad", confidence: 0.99 }],
      },
    ],
    byTerm(t1, t2, t3),
    protectedAll,
    FLOORS,
  );

  assert.deepEqual(
    out.map((s) => [s.negative, s.match_type, s.system_note]),
    [
      ["jobs", "broad", ""],
      ['"diy accident claim forms"', "phrase", "downgraded from broad"],
    ],
    "protected words/geo enforced, under-confident broad downgraded to a whole-term phrase, " +
    "all-protected phrase and whole-term-protected downgrade suggest NOTHING, hallucinated term dropped",
  );

  // Soft-category floor: informational/job_seeker phrase passes at 0.45; other categories need 0.6.
  const t4 = row("what is a deposition", { cost: 5 });
  const soft = enforceSafety(
    [
      {
        search_term: "what is a deposition",
        category: "informational",
        reason: "research",
        negatives: [
          { text: "what is a deposition", match_type: "phrase", confidence: 0.5 },  // >= 0.45 -> kept
          { text: "deposition meaning", match_type: "phrase", confidence: 0.44 },   // below soft floor -> dropped
        ],
      },
      {
        search_term: "what is a deposition",
        category: "wrong_service",
        reason: "non-soft category",
        negatives: [{ text: "deposition help", match_type: "phrase", confidence: 0.5 }], // < 0.6 -> dropped
      },
    ],
    byTerm(t4),
    protectedAll,
    FLOORS,
  );
  assert.deepEqual(soft.map((s) => [s.negative, s.category]), [['"what is a deposition"', "informational"]],
    "soft floor 0.45 applies only to informational/job_seeker");

  // Exact preserved; unknown match type coerced to phrase; broad downgrade also
  // honors the SOFT floor for soft categories (0.45 <= conf < 0.8).
  const t5 = row("law school rankings", { cost: 3 });
  const kinds = enforceSafety(
    [
      {
        search_term: "law school rankings",
        category: "job_seeker",
        reason: "r",
        negatives: [
          { text: "rankings", match_type: "broad", confidence: 0.5 },   // soft downgrade -> phrase whole term
          { text: "school rankings", match_type: "exact", confidence: 0.7 },
          { text: "rankings list", match_type: "negative_phrase", confidence: 0.7 }, // unknown -> phrase
        ],
      },
    ],
    byTerm(t5),
    protectedAll,
    FLOORS,
  );
  assert.deepEqual(
    kinds.map((s) => [s.negative, s.match_type]),
    [
      ['"law school rankings"', "phrase"],
      ["[school rankings]", "exact"],
      ['"rankings list"', "phrase"],
    ],
  );
}

// ── (e) dedupeNegatives — collapse across terms, sum metrics, sort by cost ──
{
  const a = row("plumber salary maryland", { cost: 40, impressions: 200, clicks: 8, conversions: 0 });
  const b = row("plumbing salary 2026", { cost: 10, impressions: 50, clicks: 2, conversions: 1 });
  const c = row("diy drain fix", { cost: 20, impressions: 30, clicks: 3, conversions: 0 });
  const mk = (term: SearchTermRowT, negative: string, conf: number, note = "") => ({
    negative, match_type: "broad", category: "job_seeker", reason: "r", confidence: conf,
    system_note: note, term,
  });

  const out = dedupeNegatives([mk(b, "salary", 0.85), mk(a, "salary", 0.95), mk(c, "diy", 0.9)]);
  assert.deepEqual(out.map((s) => s.negative), ["salary", "diy"], "sorted by summed cost desc");
  const sal = out[0];
  assert.equal(sal.covered_terms, 2);
  assert.equal(sal.search_term, "plumber salary maryland", "representative = highest-cost member");
  assert.equal(sal.cost, 50);
  assert.equal(sal.impressions, 250);
  assert.equal(sal.clicks, 10);
  assert.equal(sal.conversions, 1);
  assert.equal(sal.confidence, 0.95, "max member confidence");
  assert.equal(sal.avg_cpc, 5, "summed cost / summed clicks");
  assert.equal(sal.system_note, "covers 2 search terms");
  assert.deepEqual([sal.blocks_converting, sal.blocks_converting_more], [[], 0], "caution fields start empty");
  assert.equal(out[1].system_note, "", "single-term rows get no covers note");

  const noted = dedupeNegatives([mk(a, "salary", 0.9, "downgraded from broad"), mk(b, "salary", 0.8)]);
  assert.equal(noted[0].system_note, "downgraded from broad; covers 2 search terms",
    "existing note prefixes the covers note");
}

// ── (f) prompt fidelity — reason-first prompts stay verbatim in suggest.ts ──
{
  const src = readFileSync("server/services/adsOs/keywordIntel/suggest.ts", "utf8");
  for (const sentinel of [
    // system prompt: reason-first ordering, KEEP test, categories, broad self-test, geo rule
    "intent_summary",
    "WHEN TO NEGATE: only for terms that clearly FAIL the KEEP test",
    "CATEGORIES (pick the single best fit):",
    "CHOOSING THE NEGATIVE (most efficient that is SAFE):",
    "BROAD SELF-TEST first: before emitting a broad word",
    "Competitor or person names: emit one broad negative per name word",
    // user prompt scaffolding
    "CLIENT CONTEXT",
    "ACTIVELY TARGETED KEYWORDS (the client bids on these",
    "PROTECTED_WORDS (never use any of these as a broad negative root):",
    "PROTECTED_GEO (service-area locations — NEVER negate these in any match type",
    "SEARCH TERMS (lookback window; columns: term | campaign | ad group | matched keyword | ",
  ]) {
    assert.ok(src.includes(sentinel), `suggest.ts keeps verbatim prompt text: ${JSON.stringify(sentinel)}`);
  }
}

console.log("ads-os-keyword-intel-safety: all assertions passed");
