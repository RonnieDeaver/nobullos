/* test-registration
{
  "name": "Website team collapsed-grid contract — served fallback, state-gated hiding, disclosure a11y, wall retirement (Task #5011)",
  "smoke": true,
  "smokeReason": "Guards the #5011 team-band treatment that replaced the #4979 endless wall: the committed homepage keeps serving the complete 20-card roster grid with zero disclosure chrome (the toggle button and the data-team-collapsed/data-team-expanded attributes are runtime-only, so no-JS visitors always see everyone); every card-hiding rule in home.css stays keyed on the JS-set data-team-collapsed state — never viewport width alone — and only ever hides cards, with the 12/6/4/2 first-two-rows boundaries in lockstep beside the grid's 6/3/2/1-column rules; the expand rise and chevron transition stay inside prefers-reduced-motion: no-preference and under data-team-expanded; teamReveal.ts keeps its native-button disclosure seams (type=button, aria-expanded in both states, aria-controls, aria-hidden chevron) with no GSAP, ScrollTrigger, IntersectionObserver, matchMedia, or inline-style hiding; main.ts wires initTeamReveal; and the retired wall (teamWall.ts, nb-team-wall/nb-team-col selectors, data-team-mode/data-team-clone attributes) stays deleted from module, entry, CSS, and served HTML. Pure string/regex checks over four committed files — sub-second, no DB, no jsdom.",
  "regression": true,
  "scanPaths": [
    "website/public/index.html",
    "website/public/assets/css/home.css",
    "website/src/home-client/teamReveal.ts",
    "website/src/home-client/main.ts"
  ],
  "tier": "small"
}
test-registration */
// Static contract for the homepage team band's #5011 collapsed-grid
// disclosure — the 1:1 successor of the retired wall contract suite
// (tests/website-team-wall-contract.test.ts left with teamWall.ts; the
// #4979/#4903 endless wall is retired on the owner's verdict, so the
// band never scrolls or drifts for any visitor).
//
// The contract, in five parts:
//   1. SERVED markup is the complete presentation: all 20 roster cards
//      in ONE grid with ZERO disclosure chrome — the toggle button and
//      the collapse/expand attributes exist only after
//      home-client/teamReveal.ts runs, so visitors without JS always
//      see the full roster (never viewport-only hiding of people).
//   2. Hiding is STATE-gated, never width-gated: every card-hiding CSS
//      rule keys on .nb-team[data-team-collapsed="1"] — the JS-set
//      marker — and only ever hides cards (never the grid, never the
//      button). The width queries merely translate "first two rows"
//      into each breakpoint's column count (6-col band = 12 cards,
//      3-col = 6, 2-col = 4, 1-col = 2) beside the .nb-team-grid column rules
//      they mirror.
//   3. Motion is opt-in: the expand rise and the chevron transition
//      live only inside prefers-reduced-motion: no-preference media
//      blocks, and the rise fires only under data-team-expanded="1".
//   4. The disclosure is accessible: a native type="button" toggle
//      with aria-expanded in BOTH states, aria-controls naming the
//      grid, an aria-hidden chevron, and display:none hiding (removes
//      collapsed cards from tab order and the accessibility tree) —
//      and the module carries none of the wall's machinery (checked on
//      comment-stripped source so the module may still NARRATE what it
//      excludes).
//   5. The wall stays dead: teamWall.ts and its contract suite are
//      deleted; wall selectors/attributes are absent from the entry,
//      the stylesheet (comments included), and the served page.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const HTML_PATH = "website/public/index.html";
const CSS_PATH = "website/public/assets/css/home.css";
const MODULE_PATH = "website/src/home-client/teamReveal.ts";
const MAIN_PATH = "website/src/home-client/main.ts";

const WALL_STEMS = [
  "nb-team-wall",
  "nb-team-col",
  'data-team-mode',
  "data-team-clone",
] as const;

const EXPECTED_TEAM = [
  { img: "ronnie2.jpg", name: "Ronnie Deaver", role: "Founder" },
  { img: "oliver.webp", name: "Oliver Goessler", role: "Head of Operations" },
  { img: "brett2.jpg", name: "Brett Barney", role: "Head of Accounts" },
  { img: "jeff.jpg", name: "Jeff Mangle", role: "Head of Sales" },
  { img: "janno2.jpg", name: "Janno Perez", role: "Head of Paid Search" },
  { img: "cam-2026.jpg", name: "Cam Duhart", role: "Sr. Intake Engineer" },
  { img: "jake2.jpg", name: "Jake Davis", role: "Sr. Marketing Engineer" },
  { img: "jason.jpg", name: "Jason Robbins", role: "Marketing Engineer" },
  {
    img: "priyanka-2026.jpg",
    name: "Priyanka Lakha",
    role: "Onboarding Engineer",
  },
  { img: "cat2.jpg", name: "Cat McManus", role: "Executive Assistant" },
  { img: "juan.jpg", name: "Juan Antoniazzi", role: "Senior Paid Search Expert" },
  {
    img: "santiago.jpg",
    name: "Santiago Sanchez",
    role: "Senior Paid Search Expert",
  },
  {
    img: "devin-2026.jpg",
    name: "Devin Petersen",
    role: "Senior Paid Search Expert",
  },
  {
    img: "kreston.jpg",
    name: "Kreston Nathras",
    role: "Senior Paid Search Expert",
  },
  {
    img: "kaylie.jpg",
    name: "Kaylie Dietrichsen",
    role: "Paid Search Expert",
  },
  {
    img: "inno.jpg",
    name: "Inno Mdletshe",
    role: "Paid Search Expert",
  },
  {
    img: "jordan.jpg",
    name: "Jordan Scrimgeour",
    role: "Google Business Profile Expert",
  },
  {
    img: "liri-abdullahu-2026.jpg",
    name: "Liri Abdullahu",
    role: "Intake Engineer",
  },
  { img: "cleo.jpg", name: "Cleo Ortega", role: "Virtual Assistant" },
  { img: "lotis.jpg", name: "Lotis Florida", role: "Virtual Assistant" },
] as const;

let checks = 0;

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function count(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Every index at which `needle` occurs in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

type MediaBlock = { prelude: string; bodyStart: number; bodyEnd: number; body: string };

/** Top-level @media blocks of a comment-stripped stylesheet (this sheet
 *  never nests media queries). */
function mediaBlocks(css: string): MediaBlock[] {
  const out: MediaBlock[] = [];
  let i = 0;
  for (;;) {
    const at = css.indexOf("@media", i);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    out.push({
      prelude: css.slice(at, open),
      bodyStart: open + 1,
      bodyEnd: j - 1,
      body: css.slice(open + 1, j - 1),
    });
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Served HTML — complete grid, zero runtime chrome, wall gone
// ---------------------------------------------------------------------------

const htmlRaw = readFileSync(HTML_PATH, "utf8");
const html = stripHtmlComments(htmlRaw);

const teamStart = html.indexOf('<section class="nb-team">');
assert.notEqual(teamStart, -1, "team band section present in served HTML");
checks += 1;
const teamEnd = html.indexOf("</section>", teamStart);
assert.notEqual(teamEnd, -1, "team band section closes");
checks += 1;
const teamHtml = html.slice(teamStart, teamEnd);

assert.equal(
  count(teamHtml, 'class="nb-team-card"'),
  20,
  "served team band carries the complete 20-card roster (the no-JS presentation)",
);
checks += 1;
assert.equal(
  count(teamHtml, 'class="nb-team-grid"'),
  1,
  "exactly ONE roster grid — no split/secondary containers",
);
checks += 1;

let rosterCursor = -1;
for (const member of EXPECTED_TEAM) {
  const imagePos = teamHtml.indexOf(
    `src="nobull-redesign/team/${member.img}" alt="${member.name}"`,
  );
  const namePos = teamHtml.indexOf(`<h3>${member.name}</h3>`, imagePos);
  const rolePos = teamHtml.indexOf(
    `<span class="nb-team-role">${member.role}</span>`,
    namePos,
  );
  assert.ok(
    imagePos > rosterCursor && namePos > imagePos && rolePos > namePos,
    `served roster keeps exact image/name/role order for ${member.name}`,
  );
  rosterCursor = imagePos;
  checks += 1;
}

// Runtime-only disclosure chrome must NOT be serialized into the page:
// teamReveal.ts creates it, so its absence here proves no-JS visitors
// get the untouched complete grid.
for (const runtimeOnly of [
  "nb-team-reveal",
  "data-team-collapsed",
  "data-team-expanded",
  "nb-team-roster",
]) {
  assert.ok(
    !html.includes(runtimeOnly),
    `disclosure chrome is runtime-only, never served: ${runtimeOnly}`,
  );
  checks += 1;
}

// Retired band chrome stays out of the team slice (carried over from the
// wall suite: the #4261 details-disclosure family and in-band ask).
for (const retired of ["nb-team-ask", "<details", "nb-team-more"]) {
  assert.ok(
    !teamHtml.includes(retired),
    `retired team-band chrome stays out: ${retired}`,
  );
  checks += 1;
}

// Wall stems dead in the served page — RAW html so comments count too.
for (const stem of WALL_STEMS) {
  assert.ok(!htmlRaw.includes(stem), `wall stem absent from served HTML: ${stem}`);
  checks += 1;
}

// ---------------------------------------------------------------------------
// 2. CSS — state-gated hiding, per-breakpoint lockstep, motion gating
// ---------------------------------------------------------------------------

const cssRaw = readFileSync(CSS_PATH, "utf8");
const css = stripCssComments(cssRaw);

// Wall family dead in the stylesheet — RAW css so comments count too.
for (const stem of WALL_STEMS) {
  assert.ok(!cssRaw.includes(stem), `wall stem absent from home.css: ${stem}`);
  checks += 1;
}

// The four collapse boundaries exist verbatim: 6-col base keeps 12
// cards, the 851–1000px 3-col split keeps 6, the 850px 2-col split keeps 4,
// the 520px 1-col split keeps 2.
const BASE_RULE =
  '.nb-team[data-team-collapsed="1"] .nb-team-grid .nb-team-card:nth-child(n+13){display:none}';
const RULE_1000 =
  '.nb-team[data-team-collapsed="1"] .nb-team-grid .nb-team-card:nth-child(n+7){display:none}';
const RULE_850 =
  '.nb-team[data-team-collapsed="1"] .nb-team-grid .nb-team-card:nth-child(n+5){display:none}';
const RULE_520 =
  '.nb-team[data-team-collapsed="1"] .nb-team-grid .nb-team-card:nth-child(n+3){display:none}';
for (const rule of [BASE_RULE, RULE_1000, RULE_850, RULE_520]) {
  assert.equal(count(css, rule), 1, `collapse boundary rule present once: ${rule}`);
  checks += 1;
}

// Lockstep: each narrow boundary lives INSIDE the same shared width block
// as the .nb-team-grid column rule it mirrors, so a future column change
// cannot silently orphan its "two rows" arithmetic.
const blocks = mediaBlocks(css);
const shared1000 = blocks.find(
  (b) =>
    b.prelude.includes("min-width:851px") &&
    b.prelude.includes("max-width:1000px") &&
    !b.prelude.includes("prefers-reduced-motion"),
);
assert.ok(shared1000, "shared 851–1000px media block exists");
checks += 1;
assert.ok(
  shared1000!.body.includes(".nb-team-grid{grid-template-columns:repeat(3,1fr)}") &&
    shared1000!.body.includes(RULE_1000),
  "851–1000px block pairs the 3-col grid rule with the 6-card collapse boundary",
);
checks += 1;
const shared850 = blocks.find(
  (b) => b.prelude.includes("max-width:850px") && !b.prelude.includes("prefers-reduced-motion"),
);
assert.ok(shared850, "shared 850px media block exists");
checks += 1;
assert.ok(
  shared850!.body.includes(".nb-team-grid{grid-template-columns:1fr 1fr") &&
    shared850!.body.includes(RULE_850),
  "850px block pairs the 2-col grid rule with the 4-card collapse boundary",
);
checks += 1;
const shared520 = blocks.find(
  (b) => b.prelude.includes("max-width:520px") && !b.prelude.includes("prefers-reduced-motion"),
);
assert.ok(shared520, "shared 520px media block exists");
checks += 1;
assert.ok(
  shared520!.body.includes(".nb-team-grid{grid-template-columns:1fr}") &&
    shared520!.body.includes(RULE_520),
  "520px block pairs the 1-col grid rule with the 2-card collapse boundary",
);
checks += 1;

// EVERY team-band hiding rule is gated on the JS-set collapse state and
// only ever hides cards — never the grid, the section, or the button.
// (Viewport width alone must never hide a person; a bare width-gated
// display:none on team markup fails here.)
let hidingRules = 0;
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1];
  const body = m[2];
  if (!selector.includes(".nb-team") || !body.includes("display:none")) continue;
  hidingRules += 1;
  assert.ok(
    selector.includes('[data-team-collapsed="1"]'),
    `team hiding rule must key on the JS-set collapse state: ${selector.trim()}`,
  );
  assert.ok(
    selector.includes(".nb-team-card"),
    `team hiding rule may only hide cards: ${selector.trim()}`,
  );
}
assert.equal(hidingRules, 4, "exactly the four per-breakpoint collapse rules hide anything");
checks += 1;

// Expand motion is reduced-motion-gated: every use of the rise animation
// sits inside a prefers-reduced-motion: no-preference block and fires
// only in the expanded state.
const riseUses = indicesOf(css, "animation:nb-team-rise");
assert.equal(riseUses.length, 4, "one rise rule per breakpoint boundary");
checks += 1;
for (const idx of riseUses) {
  const home = blocks.find((b) => idx > b.bodyStart && idx < b.bodyEnd);
  assert.ok(
    home && home.prelude.includes("prefers-reduced-motion: no-preference"),
    "rise animation only inside prefers-reduced-motion: no-preference",
  );
  checks += 1;
}
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!m[2].includes("animation:nb-team-rise")) continue;
  assert.ok(
    m[1].includes('[data-team-expanded="1"]'),
    `rise animation fires only in the expanded state: ${m[1].trim()}`,
  );
  checks += 1;
}
assert.equal(count(css, "@keyframes nb-team-rise{"), 1, "rise keyframes defined once");
checks += 1;

// Chevron transition is gated the same way (the flip itself — a static
// transform — still communicates state under reduced motion).
const chevronTransitions = indicesOf(css, ".nb-team-reveal-chevron{transition:");
assert.equal(chevronTransitions.length, 1, "chevron transition declared once");
checks += 1;
const chevronHome = blocks.find(
  (b) => chevronTransitions[0] > b.bodyStart && chevronTransitions[0] < b.bodyEnd,
);
assert.ok(
  chevronHome && chevronHome.prelude.includes("prefers-reduced-motion: no-preference"),
  "chevron transition only inside prefers-reduced-motion: no-preference",
);
checks += 1;
assert.ok(
  css.includes('.nb-team[data-team-expanded="1"] .nb-team-reveal-chevron{transform:rotate(180deg)}'),
  "chevron flips (statically) in the expanded state",
);
checks += 1;

// The toggle is styled, with a keyboard focus affordance.
assert.ok(css.includes(".nb-team-reveal{"), "reveal button styled");
checks += 1;
assert.ok(
  css.includes(".nb-team-reveal:focus-visible{outline:"),
  "reveal button keeps a :focus-visible outline",
);
checks += 1;

// ---------------------------------------------------------------------------
// 3. teamReveal.ts — disclosure a11y seams, none of the wall's machinery
// ---------------------------------------------------------------------------

assert.ok(existsSync(MODULE_PATH), "teamReveal.ts exists");
checks += 1;
const moduleRaw = readFileSync(MODULE_PATH, "utf8");
const moduleCode = stripTsComments(moduleRaw);

for (const seam of [
  'document.createElement("button")',
  'button.type = "button";',
  'setAttribute("aria-controls", grid.id)',
  'setAttribute("aria-expanded", "false")',
  'setAttribute("aria-expanded", "true")',
  'setAttribute("aria-hidden", "true")',
  'setAttribute("data-team-collapsed", "1")',
  'removeAttribute("data-team-collapsed")',
  'setAttribute("data-team-expanded", "1")',
  'removeAttribute("data-team-expanded")',
  '"Meet the Full Team"',
  'addEventListener("click"',
  'insertAdjacentElement("afterend", button)',
] as const) {
  assert.ok(moduleCode.includes(seam), `teamReveal.ts keeps disclosure seam: ${seam}`);
  checks += 1;
}

// None of the wall's machinery, and no width/motion gating of the
// collapse in JS — the collapse is pure layout state; CSS owns motion
// gating. No inline-style hiding either: display:none must come from the
// state-gated stylesheet so the served fallback can never be trapped.
for (const banned of [
  "gsap",
  "ScrollTrigger",
  "IntersectionObserver",
  "matchMedia",
  "setInterval",
  "requestAnimationFrame",
  ".style",
  "innerHTML",
] as const) {
  assert.ok(!moduleCode.includes(banned), `teamReveal.ts stays free of: ${banned}`);
  checks += 1;
}
for (const stem of WALL_STEMS) {
  assert.ok(!moduleRaw.includes(stem), `wall stem absent from teamReveal.ts: ${stem}`);
  checks += 1;
}

// ---------------------------------------------------------------------------
// 4. Entry wiring — main.ts runs the disclosure, wall wiring gone
// ---------------------------------------------------------------------------

const mainRaw = readFileSync(MAIN_PATH, "utf8");
const mainCode = stripTsComments(mainRaw);
assert.ok(
  mainRaw.includes('import { initTeamReveal } from "./teamReveal";'),
  "main.ts imports initTeamReveal",
);
checks += 1;
assert.ok(/^\s*initTeamReveal\(\);/m.test(mainRaw), "main.ts calls initTeamReveal()");
checks += 1;
assert.ok(
  !mainCode.includes("teamWall") && !mainCode.includes("initTeamWall"),
  "main.ts code carries no wall wiring (retirement narration in comments is fine)",
);
checks += 1;

// ---------------------------------------------------------------------------
// 5. The wall is dead
// ---------------------------------------------------------------------------

assert.ok(
  !existsSync("website/src/home-client/teamWall.ts"), // fs-scan-inputs-ignore -- retirement assert: the path must stay absent, it is not a scan input
  "teamWall.ts stays deleted",
);
checks += 1;
assert.ok(
  !existsSync("tests/website-team-wall-contract.test.ts"),
  "the wall contract suite stays retired (this suite is its successor)",
);
checks += 1;

console.log(`website-team-reveal-contract: OK — ${checks} checks`);
