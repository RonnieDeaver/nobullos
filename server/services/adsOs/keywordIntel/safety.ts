/**
 * Deterministic safety filter for negative-keyword suggestions
 * (port of backend/app/keyword_intel/safety.py — logic verbatim).
 *
 * Ported from the proven NBM Apps Script. The LLM proposes negatives; THIS code
 * is what actually decides what's safe to surface — never trust the model alone:
 *
 *   - broad negative  -> dropped if ANY of its words is protected (a broad word
 *     blocks every query containing it, so every word must be safe).
 *   - phrase / exact  -> dropped only if ALL of its words are protected (a mixed
 *     phrase like "study law" is fine even though "law" is protected).
 *   - if nothing safe survives for a term, suggest NOTHING — the term's
 *     distinctive words are all protected/relevant, so it's plausibly a real
 *     customer (we don't force an exact negative on it).
 *
 * "Protected" = client services + brand + active keywords + selected practice
 * areas + website brand/domain tokens + in-area geo. Comparison is stem-aware
 * (simple plurals/possessives collapse, so a protected "lawyer" also shields
 * "lawyers"), and geo gets US state abbreviation<->full-name expansion so MD and
 * Maryland both shield.
 *
 * Match type is baked into the suggestion text (broad=plain, "phrase", [exact])
 * so the team pastes straight into Google Ads.
 */

import type { NegativeSuggestion } from "./models";
import type { SearchTermRow } from "./queries";

const SYMBOLS_RE = /["\[\]+]/g;
const NONWORD_RE = /[^a-z0-9\s]/g;

// ------------------------------- tokenizing -------------------------------

/** Lowercase word tokens, stripping match-type symbols; drops 1-char tokens. */
export function tokenize(text: string | null | undefined): string[] {
  let s = String(text ?? "").toLowerCase().replace(SYMBOLS_RE, " ");
  s = s.replace(NONWORD_RE, " ");
  return s.split(/\s+/).filter((w) => w.length > 1);
}

export function tokensOf(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of tokenize(t)) out.add(w);
  return out;
}

/**
 * Collapse a simple plural/possessive so a protected root also shields its
 * plural — e.g. protecting "lawyer" must also shield a broad "lawyers".
 *
 * Strips a single trailing 's' on words longer than 3 chars, but never on a
 * double-s ("business", "class") and never on the 2-letter state abbreviations
 * (md, ca) that geo protection relies on. Tokenizing already removed
 * apostrophes, so "lawyer's" arrives as "lawyer". Intentionally conservative:
 * it only ever ADDS protection, so the bias is toward the safe (no-block) side.
 */
export function stem(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function stemAll(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) out.add(stem(w));
  return out;
}

// US state abbreviation <-> full name, so both forms of a service-area state
// are protected together (MD also shields "maryland", and vice-versa).
export const US_STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california",
  co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas",
  ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts",
  mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana",
  ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico",
  ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma",
  or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont",
  va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  dc: "district of columbia",
};

/**
 * Words we must NEVER turn into a broad negative (returned stem-folded).
 *
 * Active keyword tokens + brand + offered services + selected practice areas +
 * any extra protected terms. Practice areas are the cleanest structured intent
 * signal the team gives us, so a firm's selected area hard-shields its terms.
 * Converting search terms are deliberately NOT protected: a "conversion" can be
 * a wrong-number call, so shielding them would block the very negative we want.
 */
export function buildProtectedWords(
  businessName: string,
  servicesOffered: string,
  extraProtectedTerms: string,
  activeKeywordTexts: Iterable<string>,
  practiceAreas: Iterable<string> = [],
): Set<string> {
  const raw = tokensOf(businessName, servicesOffered, extraProtectedTerms);
  for (const kw of activeKeywordTexts) for (const w of tokenize(kw)) raw.add(w);
  for (const area of practiceAreas) for (const w of tokenize(area)) raw.add(w);
  return stemAll(raw);
}

/**
 * Brand/domain tokens parsed from the client's website host.
 *
 * Folding the registrable domain's labels into the protected set (e.g.
 * "smith-law.com" -> {"smith", "law"}) only ever ADDS protection, so it lowers
 * false positives with no downside. Best-effort: a blank/garbled URL yields an
 * empty set. Stem-folded to match the rest of the protected set.
 */
export function brandTokensFromWebsite(website: string): Set<string> {
  let s = String(website ?? "").trim().toLowerCase();
  if (!s) return new Set();
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, ""); // strip scheme
  let host = s.split("/")[0].split("?")[0].split("#")[0].trim();
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host) return new Set();
  let labels = host.split(".");
  labels = labels.length > 1 ? labels.slice(0, -1) : labels; // drop the TLD
  const raw = new Set<string>();
  for (const label of labels) {
    for (const tok of tokenize(label)) {
      if (tok.length > 2) raw.add(tok); // skip "io", "co", noise; keep "law", "smith"
    }
  }
  return stemAll(raw);
}

/** Service-area locations that must NEVER become a negative (any match type). */
export function buildGeoProtected(serviceArea: string): Set<string> {
  const raw = tokensOf(serviceArea);
  const saLower = String(serviceArea ?? "").toLowerCase();
  for (const [ab, name] of Object.entries(US_STATES)) {
    if (raw.has(ab) || saLower.includes(name)) {
      raw.add(ab);
      for (const w of tokenize(name)) raw.add(w);
    }
  }
  if (raw.has("dc")) raw.add("washington");
  return stemAll(raw);
}

/** broad = no symbols, phrase = "quotes", exact = [brackets] — paste-ready. */
export function formatNegative(text: string, matchType: string): string {
  const t = String(text).trim();
  if (matchType === "broad") return t;
  if (matchType === "exact") return `[${t}]`;
  return `"${t}"`;
}

/**
 * tokenize() for negative-match simulation — KEEPS 1-char tokens.
 *
 * tokenize()'s 1-char drop is safe for protection (only ever adds shielding)
 * but wrong here: it would make "chapter 7 bankruptcy" equal "chapter 9
 * bankruptcy" and report blocks Google would never apply. Google matches
 * negatives on exact word forms, so every word counts.
 */
function matchTokenize(text: string | null | undefined): string[] {
  let s = String(text ?? "").toLowerCase().replace(SYMBOLS_RE, " ");
  s = s.replace(NONWORD_RE, " ");
  return s.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Would this negative keyword block this search term, per Google's rules?
 *
 * Powers the cross-check between the two analyzer tools (a pending suggested
 * negative holds back a clashing new-keyword suggestion, and a suggested
 * negative that would block a converting term gets a caution). Mirrors Google's
 * negative matching — negatives do NOT expand to close variants, so this is
 * exact word forms (no stemming, 1-char words kept), symbols stripped:
 *   - broad  -> blocks when every negative word appears in the term (any order)
 *   - phrase -> blocks when the negative's words appear contiguously, in order
 *   - exact  -> blocks only the identical term
 * `negativeText` may be paste-ready (quotes/brackets) — tokenizing strips those.
 */
export function negativeBlocks(negativeText: string, matchType: string, termText: string): boolean {
  const neg = matchTokenize(negativeText);
  const term = matchTokenize(termText);
  if (!neg.length || !term.length) return false;
  const mt = String(matchType ?? "").trim().toLowerCase();
  if (mt === "broad") return neg.every((w) => term.includes(w));
  if (mt === "exact") return term.length === neg.length && term.every((w, i) => w === neg[i]);
  const n = neg.length; // phrase (also the safe default for an unknown match type)
  for (let i = 0; i <= term.length - n; i++) {
    let match = true;
    for (let j = 0; j < n; j++) {
      if (term[i + j] !== neg[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// ------------------------------- enforcement -------------------------------

export interface SafeNeg {
  negative: string;
  match_type: string;
  category: string;
  reason: string;
  confidence: number;
  system_note: string;
  term: SearchTermRow;
}

/** Raw negate-suggestion dict from the model (post-parse, pre-safety). */
export interface RawTermSuggestion {
  search_term: string;
  category: string;
  reason: string;
  negatives: { text: string; match_type: string; confidence: number }[];
}

// Categories whose junk is cheap to miss and rarely collides with a real query, so
// phrase/exact negatives may pass at a lower "soft" confidence floor.
const SOFT_CATEGORIES = new Set(["informational", "job_seeker"]);

function safe(
  term: SearchTermRow,
  negative: string,
  matchType: string,
  category: string,
  reason: string,
  confidence: number,
  note = "",
): SafeNeg {
  return {
    negative,
    match_type: matchType,
    category,
    reason,
    confidence,
    system_note: note,
    term,
  };
}

/**
 * Decide which proposed negatives are safe to surface — gating PER negative.
 *
 * Confidence is asymmetric by risk: a BROAD negative must clear `broadMinConf`
 * (it blocks every query containing the word); a phrase/exact must clear the
 * category floor (`softMinConf` for informational/job-seeker, else
 * `defaultMinConf`). An under-confident broad isn't dropped outright — it's
 * DOWNGRADED to a phrase of the whole search term (a strict, safe subset that
 * can't over-block). The deterministic protected-word/geo guard still has the
 * final say (stem-aware, so a protected "lawyer" also shields "lawyers"):
 *   - broad           -> dropped if ANY word is protected
 *   - phrase / exact  -> dropped only if ALL words are protected (then the term is
 *     plausibly a real customer, so we suggest nothing for it).
 */
export function enforceSafety(
  rawSuggestions: RawTermSuggestion[],
  candidatesByTerm: Map<string, SearchTermRow>,
  protectedAll: Set<string>,
  opts: { broadMinConf: number; defaultMinConf: number; softMinConf: number },
): SafeNeg[] {
  const { broadMinConf, defaultMinConf, softMinConf } = opts;
  const out: SafeNeg[] = [];
  for (const s of rawSuggestions) {
    const term = candidatesByTerm.get(s.search_term ?? "");
    if (term === undefined) continue; // hallucinated term — drop

    const category = s.category || "other";
    const reason = s.reason || "";
    const catFloor = SOFT_CATEGORIES.has(category) ? softMinConf : defaultMinConf;

    // Whole-term stems — guards the broad->phrase downgrade against negating a
    // term whose every word is protected/relevant.
    const fullStems = tokenize(term.search_term).map(stem);
    const fullAllProtected = fullStems.length > 0 && fullStems.every((st) => protectedAll.has(st));

    for (const neg of s.negatives ?? []) {
      let mt = String(neg.match_type || "phrase").toLowerCase();
      const text = String(neg.text ?? "").trim();
      let conf = Number(neg.confidence ?? 0);
      if (!Number.isFinite(conf)) conf = 0.0;
      const words = tokenize(text);
      if (!words.length) continue;
      const stems = words.map(stem);
      const anyProtected = stems.some((st) => protectedAll.has(st));
      const allProtected = stems.every((st) => protectedAll.has(st));

      if (mt === "broad") {
        if (anyProtected) continue; // a protected word in a broad would block good traffic
        if (conf >= broadMinConf) {
          out.push(safe(term, formatNegative(text, "broad"), "broad", category, reason, conf));
        } else if (conf >= catFloor && !fullAllProtected) {
          out.push(safe(
            term, formatNegative(term.search_term, "phrase"), "phrase",
            category, reason, conf, "downgraded from broad",
          ));
        }
        // else: below the phrase floor (or whole term protected) -> drop
      } else {
        if (conf < catFloor) continue;
        if (allProtected) continue;
        mt = mt === "exact" ? "exact" : "phrase";
        out.push(safe(term, formatNegative(text, mt), mt, category, reason, conf));
      }
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Collapse the same negative across terms into one row, summing metrics. */
export function dedupeNegatives(safeNegs: SafeNeg[]): NegativeSuggestion[] {
  const groups = new Map<string, SafeNeg[]>();
  for (const sn of safeNegs) {
    const g = groups.get(sn.negative);
    if (g) g.push(sn);
    else groups.set(sn.negative, [sn]); // Map preserves insertion order
  }

  const out: NegativeSuggestion[] = [];
  for (const members0 of groups.values()) {
    const members = [...members0].sort((a, b) => b.term.cost - a.term.cost);
    const rep = members[0];
    const impressions = members.reduce((s, m) => s + m.term.impressions, 0);
    const clicks = members.reduce((s, m) => s + m.term.clicks, 0);
    const cost = round2(members.reduce((s, m) => s + m.term.cost, 0));
    const conversions = round2(members.reduce((s, m) => s + m.term.conversions, 0));
    const confidence = Math.max(...members.map((m) => m.confidence));
    let note = rep.system_note;
    if (members.length > 1) {
      const extra = `covers ${members.length} search terms`;
      note = note ? `${note}; ${extra}` : extra;
    }
    out.push({
      negative: rep.negative,
      match_type: rep.match_type,
      category: rep.category,
      reason: rep.reason,
      confidence: round2(confidence),
      system_note: note,
      covered_terms: members.length,
      blocks_converting: [],
      blocks_converting_more: 0,
      search_term: rep.term.search_term,
      campaign: rep.term.campaign,
      ad_group: rep.term.ad_group,
      matched_keyword: rep.term.matched_keyword,
      impressions,
      clicks,
      cost,
      conversions,
      avg_cpc: clicks > 0 ? round2(cost / clicks) : 0.0,
    });
  }
  // Highest examined cost first — most wasteful suggestions on top.
  out.sort((a, b) => b.cost - a.cost);
  return out;
}

/** Convenience used by the engine. */
export function merge(...sets: Set<string>[]): Set<string> {
  const out = new Set<string>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}
