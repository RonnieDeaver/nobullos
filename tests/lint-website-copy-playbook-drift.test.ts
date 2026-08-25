/* test-registration
{
  "name": "Lint: website copy playbook matches the rendered site (Task #4208)",
  "smoke": true,
  "smokeReason": "Guards docs/website-final-copy.md against silent drift from the rendered bundle — Tasks #4186/#4195 both found ~15 doc sections stale after sitewide wording changes (the Task #4124 session rename); this mechanizes the #4195 backtick-quote sweep so the gate catches the next rename instead of a periodic manual audit.",
  "regression": true,
  "tier": "small"
}
test-registration */
// Copy-playbook drift guard (Task #4208). docs/website-final-copy.md is the
// decided-copy record: every backtick-quoted copy string in it claims to be
// the wording the site renders. This test mechanizes the Task #4195 sweep:
// extract each quote, normalize entities/tags/typography, and verify it
// against the rendered corpus — every website/public HTML page (visible text
// + copy-bearing attributes: meta content, aria-label, alt, …), the built
// client bundles under website/public/assets, and the client-rendered
// calculator strings in website/src/calc-client/.
//
// Matching tiers (both case-insensitive on normalized text):
//   1. exact substring of the normalized corpus;
//   2. punctuation-insensitive fallback — handles the #4195 false-positive
//      classes: markup-split spans (`01 CaseGen — The Fuel` renders as three
//      sibling elements) and separator variants (`00 · Start` renders
//      `00: Start`). Word-level drift (the class this guard exists for) still
//      fails both tiers.
// Ellipsis-elided quotes (`…No grades, no benchmarks…`) verify each elided
// fragment independently.
//
// Allow-mechanism (per the task mandate): the doc legitimately RECORDS
// retired copy — `was `…``, REMOVED/DELETED sections, Task-trim history.
// Excusal is QUOTE-scoped, never paragraph-scoped (a paragraph-wide marker
// would excuse the live quote sitting next to its own "was `…`" history —
// the exact drift class this guard exists for). A missing quote is excused
// only when:
//   a. a retirement marker appears in the ~120 chars BEFORE it on its
//      logical (wrap-joined) doc line ("was `X`", "replaces `X`",
//      "trim dropped `X`", "Retired pair copy: `X`"); or
//   b. a STRONG marker (REMOVED / no longer / retired / withheld / …)
//      appears within ~80 chars AFTER it ("the `X` eyebrow was REMOVED";
//      deliberately excludes "was `"/"renamed", which trail LIVE quotes as
//      history parentheticals); or
//   c. its section heading declares the whole band gone (REMOVED / MERGED
//      INTO / FOLDED / DELETED).
// Verify-first: excusal is consulted only after both match tiers miss, so
// live quotes near markers are still checked. The floor asserts below keep
// the excusal set from quietly swallowing coverage.
// Non-copy backticks (identifiers, selectors, file paths, [proof.ts:*]
// templates, single tokens, placeholder patterns like `$___`) are skipped —
// they are notation, not rendered copy.
//
// Sibling sweeps reuse the same corpus + SweepOpts mechanism for the other
// decided-copy docs: docs/website-messaging-architecture.md (Task #4237),
// docs/website-claim-ledger.md and docs/website-copy-audit.md (Task #4246).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const DOC = "docs/website-final-copy.md";
const MSG_DOC = "docs/website-messaging-architecture.md";
const LEDGER_DOC = "docs/website-claim-ledger.md";
const AUDIT_DOC = "docs/website-copy-audit.md";
const RULE_POINTER =
  "docs/website-final-copy.md quotes this as the site's decided copy, but the rendered " +
  "corpus (website/public + calc-client) does not carry it. Either the site changed and the " +
  "doc must be reconciled (see the Task #4195 changelog entry for the reconciliation " +
  "pattern), or the doc decided new copy the site never shipped. If the quote is " +
  "deliberately retired, record that on its paragraph (REMOVED / retired / was `…`).";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", trade: "\u2122",
  times: "\u00d7", rarr: "\u2192", darr: "\u2193", middot: "\u00b7", copy: "\u00a9",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** Entity-decode, strip tags + markdown bold, unify typography, collapse
 *  whitespace, lowercase. Applied to quotes AND corpus so both sides speak
 *  the same normal form. */
function normalize(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Tier-2 form: everything that is not a word/number/figure character becomes
 *  a space. Bridges markup-split spans and separator variants only —
 *  the words themselves must still match in order. */
function loosen(s: string): string {
  return s.replace(/[^a-z0-9$%+\u00d7\u2122]+/gi, " ").replace(/\s+/g, " ").trim();
}

/** Rendered-copy text of an HTML document: visible text (comments, script and
 *  style blocks removed, then tags) PLUS copy-bearing attribute values —
 *  titles/metas/aria-labels are decided copy too and live in attributes. */
function htmlCorpusText(html: string): string {
  const noScript = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const attrVals: string[] = [];
  for (const m of noScript.matchAll(/(?:content|aria-label|alt|placeholder|value|title|label)="([^"]*)"/gi)) {
    attrVals.push(m[1]);
  }
  return noScript.replace(/<[^>]*>/g, " ") + "\n" + attrVals.join("\n");
}

function walk(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, ext));
    else if (ext.test(entry.name)) out.push(p);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Quote extraction + verification
// ---------------------------------------------------------------------------

/** Notation, not rendered copy — skipped without verification. */
function isNonCopyQuote(q: string): boolean {
  if (!/\s/.test(q)) return true; // identifiers, class names, single tokens
  if (/\$_+|\$x\.xx|\+n day|\u2014 name,/i.test(q)) return true; // placeholder patterns
  if (/\[proof\.ts:/.test(q)) return true; // generate-time templates
  if (/^[.#[]/.test(q)) return true; // selectors / anchors / bracket refs
  if (/\.(ts|tsx|md|json|png|webp|svg|html)\b/.test(q)) return true; // file refs
  if (/^\//.test(q)) return true; // URL paths
  return false;
}

/** Retirement vocabulary for text PRECEDING a quote on its logical line —
 *  "was `X`", "replaces `X`", "Task #NNNN trim dropped `X`", "the retired
 *  body owned `X`", "Rotated out of the band: `X`". */
const PREFIX_MARKERS =
  /removed|retir|replac|deleted|dropped|no longer|withheld|rotated out|supersed|swapped|tightened|trim|compression|distill|renamed|unified|was `|old |former|banned|not carried over|used to/i;
const PREFIX_WINDOW = 120;

/** STRONG markers for text FOLLOWING a quote — "the `X` eyebrow was REMOVED
 *  entirely", "`X` no longer renders". Deliberately excludes "was `" /
 *  "renamed" / "reconciled": those trail LIVE quotes as history
 *  parentheticals, and excusing on them would blind the guard to exactly
 *  the sitewide-rename drift it exists to catch. */
const SUFFIX_MARKERS =
  /removed|deleted|retired|no longer|withheld|rotated out|not carried over|do not (?:revert|rebuild|reintroduce)|left the|stays? out|banned|stale|rewritten|unified/i;
const SUFFIX_WINDOW = 80;

/** Rename-arrow suffix form: "`Old Label` → `New Label`" excuses the OLD
 *  quote — but ONLY when the arrow's target is replacement copy. The claim
 *  ledger writes link notation in the same shape ("`Label` → `/path/`"),
 *  and excusing on the bare arrow masked a genuinely stale arrow-adjacent
 *  label (Task #4340); inspect the backticked target before excusing. */
const ARROW_SUFFIX = /^ ?→ `([^`]+)`/;

/** A section whose heading declares the whole band gone excuses every miss
 *  under it (`### 3. Differentiator — REMOVED …`, `### 5. … — MERGED INTO §4`).
 *  The dash-marker form is required: live sections mention history words
 *  mid-parenthetical (§2's "…then FOLDED into the chart captions…") and must
 *  NOT be blanket-excused. */
const RETIRED_HEADING = /[—–-]\s*(?:removed|deleted|merged into|retired)\b/i;

type Verifier = { verify: (quote: string) => boolean };

function makeVerifier(rawCorpus: string): Verifier {
  const normCorpus = normalize(rawCorpus);
  const looseCorpus = loosen(normCorpus);
  const fragMatch = (f: string) => normCorpus.includes(f) || looseCorpus.includes(loosen(f));
  return {
    verify(quote: string): boolean {
      const nq = normalize(quote);
      if (nq.length < 4) return true; // too short to be evidence either way
      const frags = nq.split("...").map((f) => f.trim()).filter((f) => f.length >= 8);
      return frags.length > 1 ? frags.every(fragMatch) : fragMatch(nq);
    },
  };
}

type Result = { verified: number; skipped: number; excused: number; misses: string[] };

type LogicalLine = { text: string; firstLine: number; retiredSection: boolean };

/** Join hard-wrapped continuation lines into logical lines (quotes and their
 *  marker context both wrap in this doc), tracking whether the enclosing
 *  section heading declares the band retired. */
function logicalLines(
  docText: string,
  retiredHeading: RegExp = RETIRED_HEADING,
  extraLineStart?: RegExp,
): LogicalLine[] {
  const out: LogicalLine[] = [];
  let retiredSection = false;
  const raw = docText.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/^#/.test(line)) retiredSection = retiredHeading.test(line);
    const startsNew =
      /^\s*$|^\s*[-*#]|^\*\*|^---/.test(line) ||
      (extraLineStart?.test(line) ?? false) ||
      out.length === 0;
    if (startsNew) out.push({ text: line, firstLine: i + 1, retiredSection });
    else {
      const prev = out[out.length - 1];
      prev.text += " " + line.trim();
    }
  }
  return out;
}

function isExcused(ll: LogicalLine, quoteStart: number, quoteEnd: number): boolean {
  if (ll.retiredSection) return true;
  // Prefix includes the opening backtick so "was `" style markers match.
  const prefix = ll.text.slice(Math.max(0, quoteStart + 1 - PREFIX_WINDOW), quoteStart + 1);
  if (PREFIX_MARKERS.test(prefix)) return true;
  const suffix = ll.text.slice(quoteEnd, quoteEnd + SUFFIX_WINDOW);
  if (SUFFIX_MARKERS.test(suffix)) return true;
  // Rename arrow: excuse only when the target is replacement copy, not
  // notation (paths/file refs) — link-notation rows must not hide stale labels.
  const arrow = ARROW_SUFFIX.exec(suffix);
  return arrow !== null && !isNonCopyQuote(arrow[1]);
}

type SweepOpts = {
  doc?: string;
  rulePointer?: string;
  /** Quote pattern; every capture group is a candidate quote. Default: backticks. */
  quoteRe?: RegExp;
  /** Doc-specific notation skip, consulted in addition to isNonCopyQuote. */
  extraNonCopy?: (q: string) => boolean;
  /** Doc-specific retirement vocabulary, ORed with the shared markers. */
  extraPrefixMarkers?: RegExp;
  /** Doc-specific SUFFIX vocabulary (e.g. source citations trailing a quote). */
  extraSuffixMarkers?: RegExp;
  /** Doc-specific retired-section heading forms, ORed with RETIRED_HEADING. */
  extraRetiredHeading?: RegExp;
  /** Additional line-start forms that begin a NEW logical line (e.g. `^\|`
   *  for markdown table rows — without it a whole table joins into one
   *  logical line and excusal windows bleed across rows). */
  extraLineStart?: RegExp;
};

function sweep(docText: string, verifier: Verifier, opts: SweepOpts = {}): Result {
  const doc = opts.doc ?? DOC;
  const rulePointer = opts.rulePointer ?? RULE_POINTER;
  const res: Result = { verified: 0, skipped: 0, excused: 0, misses: [] };
  const retiredHeading =
    opts.extraRetiredHeading !== undefined
      ? new RegExp(`${RETIRED_HEADING.source}|${opts.extraRetiredHeading.source}`, "i")
      : RETIRED_HEADING;
  for (const ll of logicalLines(docText, retiredHeading, opts.extraLineStart)) {
    const re = new RegExp((opts.quoteRe ?? /`([^`]+)`/g).source, "g");
    for (const m of ll.text.matchAll(re)) {
      const q = m.slice(1).find((g) => g !== undefined)!;
      if (isNonCopyQuote(q) || (opts.extraNonCopy?.(q) ?? false)) {
        res.skipped++;
      } else if (verifier.verify(q)) {
        res.verified++;
      } else if (
        isExcused(ll, m.index!, m.index! + m[0].length) ||
        (opts.extraPrefixMarkers !== undefined &&
          opts.extraPrefixMarkers.test(
            ll.text.slice(Math.max(0, m.index! + 1 - PREFIX_WINDOW), m.index! + 1),
          )) ||
        (opts.extraSuffixMarkers !== undefined &&
          opts.extraSuffixMarkers.test(
            ll.text.slice(m.index! + m[0].length, m.index! + m[0].length + SUFFIX_WINDOW),
          ))
      ) {
        res.excused++;
      } else {
        res.misses.push(`${doc}:${ll.firstLine} — \`${q}\`\n    ↳ ${rulePointer}`);
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  // --- sanity: the sweep itself catches drift and honors its exemptions ---
  const fakeV = makeVerifier(
    htmlCorpusText(
      '<p>Book Your <em>Session</em> &rarr;</p><meta content="Revenue, Engineered">' +
        "<span>01</span><span>CaseGen</span><span>The Fuel</span>" +
        "<div>No grades here.</div><div>just your own arithmetic today</div>",
    ),
  );
  assert.equal(fakeV.verify("Book Your Session →"), true, "tag-split + entity quote must verify");
  assert.equal(fakeV.verify("Revenue, Engineered"), true, "attribute copy (meta content) must verify");
  assert.equal(fakeV.verify("01 CaseGen — The Fuel"), true, "markup-split spans must verify via the loose tier");
  assert.equal(fakeV.verify("…No grades here…just your own arithmetic…"), true, "elided quotes verify per fragment");
  assert.equal(fakeV.verify("Book A Strategy Call →"), false, "drifted wording must MISS");
  assert.equal(fakeV.verify("…No grades here…nothing like this fragment…"), false, "one dead fragment fails the elided quote");

  const doc1 = "Live line with `Book Your Session →` here.\n\nCTA: `Book A Strategy Call →` still claimed live.";
  const r1 = sweep(doc1, fakeV);
  assert.equal(r1.verified, 1, "live quote verifies");
  assert.equal(r1.misses.length, 1, "drifted quote with no retirement context must be a miss");

  const doc2 = "CTA: `Book Your Session →` (was `Book A Strategy Call →`, renamed).";
  const r2 = sweep(doc2, fakeV);
  assert.equal(r2.verified, 1, "verify-first: the live quote next to its history is still checked");
  assert.equal(r2.excused, 1, "the retired quote is excused by the preceding \"was `\" marker");
  assert.equal(r2.misses.length, 0);

  // THE drift class: the site renames sitewide, the doc quote goes stale —
  // the "was `…`" history trailing the stale quote must NOT excuse it.
  const r2b = sweep("CTA: `Book A Strategy Call →` (was `Old Label →`, renamed Task #0000).", fakeV);
  assert.equal(r2b.misses.length, 1, "a drifted LIVE quote is not excused by its own trailing history parenthetical");
  assert.equal(r2b.excused, 1, "…while the truly retired quote after \"was `\" still is");

  const r3 = sweep("- Microcopy: REMOVED (Task #0000) — the `Some retired caption line.` caption no longer renders", fakeV);
  assert.equal(r3.excused, 1, "prefix REMOVED marker excuses the recorded-retired quote");
  const r3b = sweep("- The `Some retired eyebrow` eyebrow was REMOVED entirely (operator request).", fakeV);
  assert.equal(r3b.excused, 1, "strong suffix marker (was REMOVED) excuses the quote it follows");
  const r3c = sweep(
    "### 11. Growth control — REMOVED (2026-08-06)\nSection deleted: the `Growth You Can Throttle.` H2 is gone.\n\n### 12. Team\n- H2 `Some Drifted Live Heading.` here",
    fakeV,
  );
  assert.equal(r3c.excused, 1, "REMOVED-section heading excuses the whole band's quotes");
  assert.equal(r3c.misses.length, 1, "…but not quotes in the next, live section");
  const rWrap = sweep("- Lede: REMOVED (Task #0000) — `One line that wraps\n  across the doc's hard wrap` no longer renders", fakeV);
  assert.equal(rWrap.excused, 1, "hard-wrapped quotes are joined into one logical line before extraction");

  // Rename-arrow suffix: "`Old` → `New`" excuses the old wording — but the
  // same arrow pointing at NOTATION ("`Label` → `/path/`", the claim ledger's
  // link form) must NOT excuse a drifted label (Task #4340; the #4246 gap).
  const rArrow = sweep("- CTA relabeled: `Book A Strategy Call →` → `Book Your Session →` sitewide.", fakeV);
  assert.equal(rArrow.excused, 1, "a real old → new rename arrow still excuses the old wording");
  assert.equal(rArrow.misses.length, 0);
  const rArrowLink = sweep("- Endcap rung: `Book A Strategy Call →` → `/book-free-demo/` (hard rung).", fakeV);
  assert.equal(rArrowLink.misses.length, 1, "an arrow whose target is a /path/ is link notation — the drifted label must MISS");
  assert.equal(rArrowLink.excused, 0, "…and must not be excused by the bare arrow");
  const rArrowFile = sweep("- Chart source: `Book A Strategy Call →` → `proof.ts` mapping.", fakeV);
  assert.equal(rArrowFile.misses.length, 1, "an arrow targeting a file ref does not excuse either");

  const r4 = sweep("Numbers render from `[proof.ts:PRESTI]`; class `.nb-vh`; file `proof.ts`; path `/calculator/`.", fakeV);
  assert.equal(r4.skipped, 4, "notation backticks are skipped, not verified");
  assert.equal(r4.misses.length, 0);

  // --- the real corpus ---
  const htmlFiles = walk("website/public", /\.html$/);
  assert.ok(htmlFiles.includes(path.join("website/public/index.html")), "corpus must include the homepage");
  assert.ok(htmlFiles.length >= 20, `corpus must span the whole rendered site (got ${htmlFiles.length} pages)`);
  const jsDir = "website/public/assets";
  const jsFiles = existsSync(jsDir) ? walk(jsDir, /\.js$/) : [];
  const calcFiles = walk("website/src/calc-client", /\.tsx?$/);
  assert.ok(
    calcFiles.includes(path.join("website/src/calc-client/main.ts")),
    "corpus must include the client-rendered calculator strings",
  );

  let raw = "";
  for (const f of htmlFiles) raw += "\n" + htmlCorpusText(readFileSync(f, "utf8"));
  // JS/TS sources write some typography as \uXXXX escapes — decode them so
  // the corpus carries the characters the browser renders.
  for (const f of [...jsFiles, ...calcFiles]) {
    raw +=
      "\n" +
      readFileSync(f, "utf8").replace(/\\u([0-9a-f]{4})/gi, (_m, h: string) =>
        String.fromCharCode(parseInt(h, 16)),
      );
  }

  const verifier = makeVerifier(raw);
  const res = sweep(readFileSync(DOC, "utf8"), verifier);

  // The broad copy sweep proves documentation wording is present somewhere in
  // the rendered corpus. These results-disclaimer assertions deliberately pin
  // it to the compiled Data Notes page, so another page cannot mask a removal
  // or material rewrite of this evidence-category qualifier.
  const dataNotesHtml = htmlCorpusText(readFileSync("website/public/data-notes/index.html", "utf8"));
  const dataNotesVerifier = makeVerifier(dataNotesHtml);
  const dataNotesDisclaimer = [
    "Results disclaimer",
    "No result shown on this site is guaranteed for any individual firm.",
    "Outcomes vary based on the firm, its market, practice area, and other relevant circumstances.",
  ];
  for (const copy of dataNotesDisclaimer) {
    assert.equal(
      dataNotesVerifier.verify(copy),
      true,
      `Data Notes results disclaimer must retain this decided copy: ${copy}`,
    );
  }

  // (miss assertion moved to the combined per-surface loop below so a drift
  //  hitting several docs reports every affected surface, not just the first)

  // Coverage floors: the guard is only worth its gate slot while it actually
  // verifies the bulk of the record. As of Task #4208 the sweep verifies 326
  // quotes and excuses 59; if VERIFIED collapses (over-broad skip/marker
  // logic) or EXCUSED balloons (markers swallowing live copy), fail loudly.
  assert.ok(res.verified >= 250, `verified-quote floor: ${res.verified} < 250 — exemption logic is eating coverage`);
  // Ceiling raised 80 → 84 (Task #4816): the homepage reorg genuinely retired
  // four quotes (hero trust line, gap bridge paragraph, REE gap-deixis
  // sentence, cinematic Scene 6 body), growing the excused set to 81. A
  // vocabulary over-match would jump this by tens, not ones — keep the
  // headroom small so that failure mode still trips.
  // Raised 84 → 90 (Task #4924): the four-question component rebuild and the
  // recap→customization replacement retired the recap's name-only REE
  // scoreline and left a few old §4 lines in the doc as marked retirements
  // (most retired copy moved to the changelog instead), growing the excused
  // set to 87 — same by-ones growth pattern, same small headroom.
  // Raised 90 → 97 (Task #4925): the proof-slider retirement (owner brief
  // §7) records both rate cards for the record — two dropped labels, two
  // dropped headlines, both before→after sweeps and both HOW-IT-WORKS
  // product links, each quote individually marked in §7's retirement
  // paragraph — growing the excused set to 94. Same by-ones growth
  // pattern, same small headroom.
  // Raised 97 → 100 (Task #4926): the below-testimonials restructure (owner
  // brief §§10–14) retires the team-disclosure/team-wall treatment, the old
  // closing sub-line, and the contact band, with each dropped quote
  // individually RETIRED-marked in final-copy §§9/12–14 — growing the
  // excused set to 100. Same by-ones growth pattern, same small headroom.
  // Raised 100 → 103 (Task #4979): the full-roster reorder + endless-wall
  // resurrection drops the About roster link below the team grid (the
  // complete 18-person team renders in-band now), retiring its label quote
  // with a REMOVED marker in final-copy §12 — growing the excused set to
  // 101. Same by-ones growth pattern, same small headroom.
  // Raised 103 → 112 (2026-08-18, Task #4987): the REE-strip band removal
  // flipped the strip's recorded quotes (eyebrow, H2, SR definition
  // sentence, levers head + lever list, strip CTA) from verified to
  // recorded-retired in final-copy §2b's REMOVED record — measured 107 on
  // the rebased tree (#4979 base 101 + the strip's six). Same by-ones
  // growth pattern, same small headroom.
  // Raised 112 → 113 (2026-08-19, Task #5063): the retired constraint-first
  // hero session note is retained in the copy record while its verified
  // revenue-goals-plan replacement stays live. This is one explicit
  // retirement, not a broadened exemption.
  // Raised 113 → 115 (2026-08-19): later page retirements already leave 115
  // explicitly recorded-retired quotes on the rebased tree. This is the
  // measured count, not added headroom; the Data Notes disclaimer above adds
  // verified live copy only.
  // Raised 115 → 116 (2026-08-20, Task #5134): the result-first proof
  // flagship deliberately retires its fourth `200 / 5-STAR REVIEWS` marker.
  // This is one quote-scoped retirement, not a broadened exemption.
  // Raised 116 → 117 (2026-08-21, Task #5169): the refocused flagship retires
  // its `4.8 ★ / GOOGLE RATING` marker while retaining the canonical claim in
  // the records for other approved surfaces. One marker, no extra headroom.
  assert.ok(res.excused <= 117, `excused-quote ceiling: ${res.excused} > 117 — retirement markers are over-matching`);

  // --- sibling sweep: docs/website-messaging-architecture.md (Task #4237) ---
  // The messaging doc records decided rendered copy mostly in straight double
  // quotes (rules, examples, locked headings) — sweep both backtick and
  // double-quoted spans. Many quotes are rules ABOUT copy (banned labels,
  // purged vocabulary, book-only lines), excused via the shared marker
  // mechanism plus doc-specific rule vocabulary below.
  const msgOpts: SweepOpts = {
    doc: MSG_DOC,
    rulePointer:
      "docs/website-messaging-architecture.md quotes this as decided rendered copy, but the " +
      "rendered corpus (website/public + calc-client) does not carry it. Either reconcile the " +
      "doc with the site, or mark the quote as a rule about banned/retired copy on its line " +
      "(banned / never / purged / book-only / REMOVED / was `…`).",
    quoteRe: /`([^`]+)`|"([^"]+)"/g,
    extraNonCopy: (q) =>
      /^§/.test(q) || // section cross-references (`§6 #N`)
      /^(deck|ledger|task|ch\.?|§)\s*[#\dS]/i.test(q), // source citations
    // Rule vocabulary specific to this doc: quotes preceded by these words are
    // rules ABOUT copy (banned labels, purged storyboard relics, book-only
    // lines, pending owner recommendations, book phrase-bank mining sources),
    // not claims that the string renders. `was "` is the double-quote form of
    // the shared "was `" history marker.
    extraPrefixMarkers:
      /never|avoid|purged|book-only|reserved for the book|must be zero|legacy|invented|junk|without verified|was "|recommends|proposed|pending|traits:|phrase bank|\bch\.?\s?\d|\bintro —/i,
    // Quotes trailed by a deck/book/ledger citation or a rule self-reference
    // ("the "avoid gears" rule above…") record source material, not rendered
    // copy. Live copy is still checked first (verify-first ordering).
    extraSuffixMarkers: /^\)?\s*\((?:deck|book|ledger|ch\.?\s?\d)|rule above/i,
    // §8 is an explicit purge list — every string under it is banned copy.
    extraRetiredHeading: /legacy terms.*must be zero/i,
  };
  const msg = sweep(readFileSync(MSG_DOC, "utf8"), verifier, msgOpts);
  // Self-tests for the messaging-doc options (double-quote extraction, doc
  // rule vocabulary, purge-list heading) against the synthetic corpus.
  const mFake = sweep('Hero eyebrow "Book Your Session →" is locked.', fakeV, msgOpts);
  assert.equal(mFake.verified, 1, "double-quoted live copy verifies in the messaging sweep");
  const mDrift = sweep('Closing "Book A Strategy Call →" renders sitewide.', fakeV, msgOpts);
  assert.equal(mDrift.misses.length, 1, "a drifted double-quoted claim must MISS in the messaging sweep");
  const mCite = sweep('Argument: "Some deck-only aphorism line." (deck S11).', fakeV, msgOpts);
  assert.equal(mCite.excused, 1, "a deck-cited source quote is excused by the citation suffix");
  const mBan = sweep('Banned labels anywhere: "Learn More Everywhere", "Old Junk Label".', fakeV, msgOpts);
  assert.equal(mBan.excused, 2, "banned-label rule quotes are excused by the prefix vocabulary");
  const mLegacy = sweep(
    '## 8. Legacy terms (must be zero at QA)\n\nOld stuff: "Some Dead Legacy Product Name" here.',
    fakeV,
    msgOpts,
  );
  assert.equal(mLegacy.excused, 1, "the purge-list section heading excuses its banned strings");
  assert.equal(
    sweep('Cross-ref "§6 #8" and route `/calculator/` are notation.', fakeV, msgOpts).skipped,
    2,
    "messaging-doc notation (§ cross-refs, paths) is skipped",
  );

  // Coverage floors for the new surface (Task #4237): as of adoption the sweep
  // verifies 39 quotes and excuses 25. If VERIFIED collapses the notation/rule
  // skips are over-matching; if EXCUSED balloons the rule vocabulary is
  // swallowing live copy.
  assert.ok(msg.verified >= 30, `messaging verified-quote floor: ${msg.verified} < 30 — skip/rule logic is eating coverage`);
  assert.ok(msg.excused <= 40, `messaging excused-quote ceiling: ${msg.excused} > 40 — rule vocabulary is over-matching`);

  // --- sibling sweep: docs/website-claim-ledger.md (Task #4246) ---
  // The ledger registers every published (or withheld/banned) claim with its
  // exact wording — backticked labels and double-quoted phrasings that claim
  // to render sitewide. Rows also record WITHHELD/BANNED/retired wording and
  // long surface-history parentheticals; those are excused via the shared
  // markers plus ledger-specific vocabulary below. Table rows are their own
  // logical lines (extraLineStart) so excusal windows never bleed across rows.
  const ledgerOpts: SweepOpts = {
    doc: LEDGER_DOC,
    rulePointer:
      "docs/website-claim-ledger.md registers this as published claim wording, but the rendered " +
      "corpus (website/public + calc-client) does not carry it. Either the site changed and the " +
      "ledger row must be reconciled, or the row registers wording the site never shipped. If the " +
      "wording is deliberately unpublished, mark it on its row (WITHHELD / BANNED / REMOVED / " +
      "retired / was `…`).",
    quoteRe: /`([^`]+)`|"([^"]+)"/g,
    extraLineStart: /^\|/,
    extraNonCopy: (q) =>
      /^(S\d|§|Task #|ledger #|deck )/i.test(q) || // slide/section/task citations
      /^[A-Z_]+$/.test(q), // proof.ts export names
    extraPrefixMarkers:
      /withheld|banned|dormant|supersed|never|available if|re-?usable|was "|had been|until task|assurances/i,
    extraSuffixMarkers: /withheld|banned|dormant|supersed|is gone|never|per s\d|until task|used to/i,
    extraRetiredHeading: /banned \/ never publish|known mismatches/i,
  };
  const ledger = sweep(readFileSync(LEDGER_DOC, "utf8"), verifier, ledgerOpts);

  // Self-tests for the ledger options against the synthetic corpus: table-row
  // logical-line splitting, live-label verification, drift detection, and the
  // WITHHELD/status excusal vocabulary.
  const lLive = sweep('| 1 | Claim | S8 | CS | LIVE | slide label `Book Your Session →` renders |', fakeV, ledgerOpts);
  assert.equal(lLive.verified, 1, "a live backticked ledger label verifies");
  const lDrift = sweep('| 1 | Claim | S8 | CS | LIVE | slide label `Book A Strategy Call →` renders |', fakeV, ledgerOpts);
  assert.equal(lDrift.misses.length, 1, "a drifted ledger label must MISS");
  const lRows = sweep(
    '| 1 | REMOVED — the old row | S8 | CS | LIVE | x |\n| 2 | y | S9 | CS | LIVE | label `Book A Strategy Call →` renders |',
    fakeV,
    ledgerOpts,
  );
  assert.equal(lRows.misses.length, 1, "table rows are separate logical lines — row 1's REMOVED cannot excuse row 2's drift");
  const lWithheld = sweep('| 20 | Claim | S43 | MODEL | WITHHELD — wording "Some Unpublished Model Sentence here." never shipped |', fakeV, ledgerOpts);
  assert.equal(lWithheld.excused, 1, "WITHHELD-prefixed ledger wording is excused");
  assert.equal(
    sweep('Source `S34` and export `LEADS_GENERATED` and path `/calculator/` are notation.', fakeV, ledgerOpts).skipped,
    3,
    "ledger notation (slide refs, proof.ts exports, paths) is skipped",
  );

  // --- sibling sweep: docs/website-copy-audit.md (Task #4246) ---
  // The audit doc is the pre-overhaul findings record: most quotes are
  // findings about OLD copy (banned guarantees, legacy labels, junk metas)
  // that the overhaul then rewrote — excused via the audit-finding vocabulary
  // below. Quotes it records as correct/kept are still live claims and must
  // keep matching the rendered site.
  const auditOpts: SweepOpts = {
    doc: AUDIT_DOC,
    rulePointer:
      "docs/website-copy-audit.md quotes this and the rendered corpus (website/public + " +
      "calc-client) does not carry it. If it is a finding about old/rewritten copy, mark it on " +
      "its line with the audit vocabulary (banned / legacy / unverified / junk / vague / " +
      "generic / rewritten / was `…`); if it claims kept/correct copy, reconcile it with the site.",
    quoteRe: /`([^`]+)`|"([^"]+)"/g,
    extraNonCopy: (q) => /^(S\d|§|Task #|ledger)/i.test(q),
    extraPrefixMarkers:
      /banned|unverified|legacy|junk|vague|generic|truncated|missing|wrong|contradict|conflict|duplicate|inconsisten|casual hype|pre-engine|near-legacy|currently|says?\b|reads?\b|carry|carries|label|titled|default|repeats|contains?|phrase|eyebrow|heading/i,
    extraSuffixMarkers:
      /banned|unverified|legacy|junk|vague|generic|truncated|wrong|contradict|conflict|acceptable|missing/i,
  };
  const audit = sweep(readFileSync(AUDIT_DOC, "utf8"), verifier, auditOpts);

  // Self-tests for the audit options: kept/correct copy verifies, drifted
  // kept copy misses, and old-copy findings are excused by the vocabulary.
  const aLive = sweep('- Hero CTA "Book Your Session →" is correct (keep).', fakeV, auditOpts);
  assert.equal(aLive.verified, 1, "kept/correct audit copy verifies");
  const aDrift = sweep('- Hero CTA "Book A Strategy Call →" is correct (keep).', fakeV, auditOpts);
  assert.equal(aDrift.misses.length, 1, "a drifted kept-copy audit quote must MISS");
  const aFinding = sweep('- FAQ repeats the banned "work for free until we do" guarantee.', fakeV, auditOpts);
  assert.equal(aFinding.excused, 1, "an old-copy finding is excused by the audit vocabulary");

  const allMisses = [
    ["Copy-playbook", res],
    ["Messaging-architecture", msg],
    ["Claim-ledger", ledger],
    ["Copy-audit", audit],
  ] .flatMap(([label, r]) => (r as Result).misses.map((miss) => `[${label}] ${miss}`));
  assert.deepEqual(
    allMisses,
    [],
    `Decided-copy drift: ${allMisses.length} doc quote(s) no longer match the rendered site:\n  ` +
      allMisses.join("\n  "),
  );

  // Coverage floors per surface (Task #4246): as of adoption the ledger sweep
  // verifies 69 quotes and excuses 33; the audit sweep verifies 17 and
  // excuses 32. If VERIFIED collapses the notation/finding skips are
  // over-matching; if EXCUSED balloons the vocabulary is swallowing live copy.
  // The post-rebase copy reconciliation left 51 verified claim-ledger
  // quotes. Task #5134 deliberately removes six previously rendered proof
  // beats from the homepage corpus (two Presti structure labels, its elapsed
  // time and first-lead beats, the Burns quote, and Expansion's cumulative
  // lead cell), leaving 45. This is the exact measured count, not headroom.
  assert.ok(ledger.verified >= 45, `claim-ledger verified-quote floor: ${ledger.verified} < 45 — skip/marker logic is eating coverage`);
  // Ledger ceiling raised 50 → 56 (2026-08-18, Task #5016): the session-offer
  // band removal flipped three ledger quotes from verified to recorded-retired
  // — the row-36 four-fact lede (now a was-"…" record) and the "revenue goals"
  // tail cited in row 36's source cell and the §5 qualifiers row (the lede was
  // the tail's only rendered surface). Same by-ones growth pattern as the
  // final-copy ceiling above, same small headroom.
  // Raised 56 → 62 (2026-08-20, Task #5134): the same six verified proof
  // quotes above become quote-scoped historical records. No marker vocabulary
  // was widened.
  assert.ok(ledger.excused <= 62, `claim-ledger excused-quote ceiling: ${ledger.excused} > 62 — vocabulary is over-matching`);
  assert.ok(audit.verified >= 12, `copy-audit verified-quote floor: ${audit.verified} < 12 — skip/marker logic is eating coverage`);
  assert.ok(audit.excused <= 45, `copy-audit excused-quote ceiling: ${audit.excused} > 45 — vocabulary is over-matching`);

  console.log(
    `lint-website-copy-playbook-drift: ${res.verified} quotes verified against ${htmlFiles.length} pages + ` +
      `${jsFiles.length + calcFiles.length} client sources (${res.excused} recorded-retired, ${res.skipped} notation); ` +
      `messaging-architecture: ${msg.verified} verified (${msg.excused} rule-excused, ${msg.skipped} notation); ` +
      `claim-ledger: ${ledger.verified} verified (${ledger.excused} excused, ${ledger.skipped} notation); ` +
      `copy-audit: ${audit.verified} verified (${audit.excused} excused, ${audit.skipped} notation)`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
