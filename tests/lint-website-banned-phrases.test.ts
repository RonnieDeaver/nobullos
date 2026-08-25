/* test-registration
{
  "name": "Lint: website banned phrases stay purged (Task #4044 + scale-up directive)",
  "smoke": true,
  "smokeReason": "Guards published copy against reintroducing the storyboard vocabulary purged by Task #4032, the growth-control/throttle framing banned by the owner directive of 2026-08-07 (Task #4035), and the ROAS comparison deleted sitewide by the owner decision of 2026-08-09 (Task #4166); a careless copy edit or merge would otherwise ship any of them silently.",
  "regression": true,
  "tier": "small"
}
test-registration */
// Source-scan guard over THREE banned-phrase lists:
//  1. the invented storyboard vocabulary purged from all published copy
//     (Task #4032) — list + rationale in
//     docs/website-messaging-architecture.md §3 ("Purged invented
//     vocabulary");
//  2. the growth-control/throttle framing the owner banned from the site
//     (directive 2026-08-07, enforced sitewide by Task #4035) — the website
//     never frames growth as a dial you can also turn down; it sells
//     uncapped scale-up. Rule: messaging-architecture §6 #8 + claim ledger
//     #25 (book-only). The /free-chapters/ excerpt JSON is verbatim book
//     content and is NOT a scanned surface (the book keeps the concept —
//     its Ch4 ToC title "The Growth Control System" stays);
//  3. ROAS (owner decision 2026-08-09, Task #4166: "lawyers don't think in
//     ROAS") — the REE strip's ROAS comparison was deleted sitewide and the
//     term must not creep back into rendered copy OR the decided-copy docs.
//     This list alone ALSO scans docs/website-final-copy.md and
//     docs/website-messaging-architecture.md (raw text; those docs
//     legitimately DOCUMENT the other two lists, so only the ROAS list
//     applies to them). docs/website-copy-changelog.md is history and is
//     deliberately NOT a scanned surface.
// Scanned surfaces: the cinematic stage copy module,
// every generator page module's string copy, and the generated homepage's
// visible text; every TS module under website/src is scanned. Exempt by design: code comments, CSS classes/identifiers
// (nb-machinery), and asset filenames (machinery-hero.png) — i.e. any
// hyphenated occurrence.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// "qualified demand" left this list on 2026-08-10: the owner's cinematic
// rebuild brief (design-source/nobull-revenue-engine-cinematic-v2/BRIEF.md
// §7, Task #4295) re-adopted the phrase verbatim in the CaseGen scene's
// when-installed statement, superseding the earlier retirement of the old
// stage-01 eyebrow wording.
const BANNED_PHRASES = [
  "machinery",
  "no magic",
  "watch it assemble",
] as const;

// Owner directive 2026-08-07 (Task #4035): the site must never make the
// growth-control point — growth as something you throttle up OR down. That
// concept is book-only (claim ledger #25). Substring match (so "throttles"/
// "throttled"/"consolidates" hit too), with a leading letter-boundary so
// camelCase code identifiers (rafThrottled) stay clean.
const BANNED_GROWTH_CONTROL_PHRASES = [
  "throttle",
  "rev it up",
  "ease it back",
  "growth is a dial",
  "dial you own",
  "you have control",
  "slow it down",
  "growth you control",
  "control of growth",
  "consolidate",
] as const;

// Owner decision 2026-08-09 (Task #4166): the ROAS comparison is deleted
// sitewide — "lawyers don't think in ROAS". Unlike the lists above these
// need a TRAILING letter boundary too ("roast"/"roasted" must never hit),
// so they get fully bounded matching in scan().
const BANNED_BOUNDED_PHRASES = ["roas"] as const;

const ALL_BANNED_PHRASES = [
  ...BANNED_PHRASES,
  ...BANNED_GROWTH_CONTROL_PHRASES,
  ...BANNED_BOUNDED_PHRASES,
] as const;

const BOUNDED_SET = new Set<string>(BANNED_BOUNDED_PHRASES);

const RULE_POINTER =
  "banned by the Task #4032 purge list — see docs/website-messaging-architecture.md §3 " +
  '("Purged invented vocabulary"). Rewrite the copy in the book voice; do not exempt it here ' +
  "unless it is a code identifier, CSS class, or asset filename.";

const GROWTH_CONTROL_RULE_POINTER =
  "banned by the scale-up-only owner directive (2026-08-07, Task #4035) — the website never " +
  "frames growth as a dial you can turn down; that concept is reserved for the book. See " +
  "docs/website-messaging-architecture.md §6 #8 and docs/website-claim-ledger.md #25. " +
  "Sell uncapped scale-up instead (the installed engine removes the ceiling).";

const ROAS_RULE_POINTER =
  'deleted sitewide by owner decision 2026-08-09 (Task #4166) — "lawyers don\'t think in ' +
  'ROAS". The site never compares REE to ROAS; REE stands on its own (the strip posts the ' +
  "score, the cinematic's stage bodies carry the levers). Applies to rendered copy AND the " +
  "decided-copy docs; only the copy-changelog keeps historical mentions.";

/**
 * Strips // and /* *​/ comments from TS source while keeping string and
 * template-literal contents intact (URLs like https:// inside strings must
 * not be mistaken for line comments). Everything that is not a comment is
 * kept, so copy in string literals is scanned.
 */
function stripComments(src: string): string {
  let out = "";
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && n === "/") {
          state = "line";
          i++;
        } else if (c === "/" && n === "*") {
          state = "block";
          i++;
        } else {
          if (c === "'") state = "single";
          else if (c === '"') state = "double";
          else if (c === "`") state = "template";
          out += c;
        }
        break;
      case "line":
        if (c === "\n") {
          state = "code";
          out += c;
        }
        break;
      case "block":
        if (c === "*" && n === "/") {
          state = "code";
          i++;
        } else if (c === "\n") {
          out += c; // preserve line numbers for hit reporting
        }
        break;
      case "single":
      case "double":
      case "template": {
        out += c;
        if (c === "\\") {
          out += src[i + 1] ?? "";
          i++;
        } else if (
          (state === "single" && c === "'") ||
          (state === "double" && c === '"') ||
          (state === "template" && c === "`")
        ) {
          state = "code";
        }
        break;
      }
    }
  }
  return out;
}

/** Visible text of an HTML document: comments, script/style blocks, and all
 *  tags (where class attrs and asset paths live) removed. */
function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

type Hit = { file: string; line: number; phrase: string; context: string };

/** All .ts/.tsx files under a directory, recursively, sorted. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(p));
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out.sort();
}

/** A hit is exempt when it is part of a hyphenated identifier / CSS class /
 *  asset filename (nb-machinery, machinery-hero.png, machinery-img). */
function isHyphenatedIdentifier(text: string, start: number, end: number): boolean {
  const prev = text[start - 1] ?? "";
  const next = text[end] ?? "";
  if (prev === "-" || next === "-") return true;
  // Filename exemption: only a real file extension counts ("machinery.webp"),
  // never ordinary punctuation ("No magic." must still fail).
  return /^\.(png|webp|jpe?g|svg|gif|avif|ico|css|js|mjs|tsx?|json|html|mp4|woff2?)\b/i.test(
    text.slice(end, end + 8),
  );
}

function scan(
  file: string,
  text: string,
  phrases: readonly string[] = ALL_BANNED_PHRASES,
): Hit[] {
  const hits: Hit[] = [];
  for (const phrase of phrases) {
    // Leading letter-boundary: copy hits ("the throttle", "Throttle.") match,
    // camelCase identifiers (rafThrottled) don't. No trailing boundary, so
    // inflections ("throttles", "consolidating") still hit — EXCEPT the
    // bounded list (ROAS), where a trailing boundary keeps "roast"/"roasted"
    // clean.
    const re = new RegExp(
      "(?<![A-Za-z])" +
        phrase.replace(/ /g, "\\s+") +
        (BOUNDED_SET.has(phrase) ? "(?![A-Za-z])" : ""),
      "gi",
    );
    for (const m of text.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (isHyphenatedIdentifier(text, start, end)) continue;
      const line = text.slice(0, start).split("\n").length;
      const context = text
        .slice(Math.max(0, start - 50), Math.min(text.length, end + 50))
        .replace(/\s+/g, " ")
        .trim();
      hits.push({ file, line, phrase, context });
    }
  }
  return hits;
}

async function run() {
  // --- sanity: the scanner itself catches phrases and honors exemptions ---
  assert.equal(scan("x", "the machinery hums").length, 1, "scanner must catch a bare phrase");
  assert.equal(scan("x", "No Magic here").length, 1, "scanner must be case-insensitive");
  assert.equal(scan("x", "They buy help. No magic.").length, 1, "trailing punctuation is not a filename exemption");
  assert.equal(scan("x", "watch it\n  assemble").length, 1, "scanner must match across whitespace/newlines");
  assert.equal(scan("x", "nb-machinery machinery-img machinery-hero.png machinery.webp").length, 0, "hyphenated identifiers / filenames are exempt");
  assert.equal(
    scan("x", stripComments('// machinery in a comment\nconst a = 1; /* qualified demand */')).length,
    0,
    "code comments are exempt",
  );
  assert.equal(
    scan("x", stripComments('const url = "https://x.test/machinery hums"; // ok')).length,
    1,
    "string contents after a // inside a string must still be scanned",
  );
  assert.equal(
    scan("x", htmlVisibleText('<div class="nb-machinery"><!-- machinery --><img src="machinery-hero.png"></div>real machinery text')).length,
    1,
    "HTML: tags/comments exempt, visible text scanned",
  );
  assert.equal(scan("x", "Your hand on the throttle.").length, 1, "growth-control list: throttle framing must be caught");
  assert.equal(scan("x", "Now growth is a dial.").length, 1, "growth-control list: dial framing must be caught");
  assert.equal(scan("x", "including when to slow it down").length, 1, "growth-control list: slow-down framing must be caught");
  assert.equal(scan("x", "const t = rafThrottled(onScroll);").length, 0, "camelCase code identifiers are not copy hits");
  assert.equal(
    scan("x", "Chapter 4: The Growth Control System").length,
    0,
    "the book's Ch4 ToC title alone is not a hit — book content keeps the concept",
  );
  assert.equal(
    scan("x", "ROAS hands you a ratio.").length,
    1,
    "ROAS must be caught (owner 2026-08-09: lawyers don't think in ROAS)",
  );
  assert.equal(
    scan("x", "a roast, roasted beans, the Roastery").length,
    0,
    "bounded match: roast/roasted/Roastery are not ROAS hits",
  );
  assert.equal(
    scan("x", "the retired nb-ree-roas class").length,
    0,
    "hyphenated identifiers stay exempt for the bounded list too",
  );

  // --- the real surfaces ---
  const hits: Hit[] = [];

  // Every TS module under website/src — pages, home-client bundle sources,
  // and shared modules (proof.ts, html.ts, …) all feed user-visible copy
  // into the generated site, so all of them are scanned.
  const tsSurfaces = walkTs("website/src");
  assert.ok(
    tsSurfaces.includes(path.join("website/src/home-client/engineStory.ts")),
    "surface walk must include the home-client bundle sources",
  );
  assert.ok(
    tsSurfaces.includes(path.join("website/src/pages/home.ts")),
    "surface walk must include the page modules",
  );
  assert.ok(
    tsSurfaces.some((f) => !f.startsWith("website/src/pages/") && !f.startsWith("website/src/home-client/")),
    "surface walk must include shared website/src modules (proof.ts, html.ts, …)",
  );
  for (const file of tsSurfaces) {
    hits.push(...scan(file, stripComments(readFileSync(file, "utf8"))));
  }

  const htmlFile = "website/public/index.html";
  hits.push(...scan(htmlFile, htmlVisibleText(readFileSync(htmlFile, "utf8"))));

  // Decided-copy docs: ROAS list ONLY (they legitimately document the other
  // two lists); the copy-changelog keeps its history and is not scanned.
  const docSurfaces = [
    "docs/website-final-copy.md",
    "docs/website-messaging-architecture.md",
  ] as const;
  for (const file of docSurfaces) {
    hits.push(...scan(file, readFileSync(file, "utf8"), BANNED_BOUNDED_PHRASES));
  }

  const growthList = new Set<string>(BANNED_GROWTH_CONTROL_PHRASES);
  assert.deepEqual(
    hits,
    [],
    `Banned phrase(s) found in published copy:\n` +
      hits
        .map(
          (h) =>
            `  ${h.file}:${h.line} — "${h.phrase}" in: …${h.context}…\n    ↳ ${
              BOUNDED_SET.has(h.phrase)
                ? ROAS_RULE_POINTER
                : growthList.has(h.phrase)
                  ? GROWTH_CONTROL_RULE_POINTER
                  : RULE_POINTER
            }`,
        )
        .join("\n"),
  );

  console.log(
    `lint-website-banned-phrases: ${tsSurfaces.length + 1 + docSurfaces.length} surfaces clean of ${ALL_BANNED_PHRASES.length} banned phrases`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
