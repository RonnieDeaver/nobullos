/* test-registration
{
  "name": "Website product funnel static integrity — complete fully-lit no-JS content, decorative engravings, nothing pinned or frame-fed (Task #4992)",
  "smoke": true,
  "smokeReason": "Guards the #4992 no-JS/reduced-motion contract for the #system product section: the committed homepage carries the ONE continuous funnel (three stacked stages + SIGNED CASES plaque + the section's single session CTA) in its fully-lit final state — the stylesheet's illumination overlays read --fn-* custom properties with LIT fallbacks and never key on [data-fn-*], the funnel geometry is the two nested clip-path trapezoids whose gold sliver is the continuous border, the stage numerals/emblems are aria-hidden decoration, and no canvas/frame/pin machinery — nor the retired engine-story class families (charcoal overview, component sections + sticky index, diagram language, customization band), nor the #4923-deleted handoff band's CSS, nor the #4925-retired proof-slider/rate-card/ramp/ladder/REE-example families (the testimonials marquee left that list — Task #4980 restored it) — survives in markup or stylesheet. A regression that dims static visitors' funnel or resurrects a retired family fails here in under a second with no DB.",
  "regression": true,
  "scanPaths": ["website/public/index.html", "website/public/assets/css/home.css"],
  "tier": "small"
}
test-registration */
// Static-integrity guard for the #system product section (Task #4992,
// owner funnel brief — replaced the #4837/#4923/#4924 engine story: the
// charcoal overview, the three component sections with their diagrams,
// receipts and sticky index, and the customization band all left with
// this redesign; their class families join the retired-CSS list below).
// The section reads complete with JS disabled and with animations off:
// engineStory.ts focuses one stage at runtime only via the --fn-veil /
// --fn-lume custom properties, whose stylesheet fallbacks are the LIT
// values — so the committed markup + stylesheet must never hide or dim
// the funnel on their own. This suite pins that contract
// plus the funnel's structural shape (three stages in engine order, the
// plaque as the terminal result, one CTA) and the absence of every
// retired mechanism (canvas, frame sequences, data-mode/presentation
// switching, pinned-viewport CSS, sticky index).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const HTML_PATH = "website/public/index.html";
const CSS_PATH = "website/public/assets/css/home.css";

function sliceFunnel(html: string): string {
  const start = html.indexOf('<section id="system" class="nb-funnel"');
  assert.ok(start >= 0, "generated homepage contains the #system funnel");
  const end = html.indexOf("</section>", start);
  assert.ok(end > start, "funnel section closes");
  return html.slice(start, end);
}
function main(): void {
  const html = readFileSync(HTML_PATH, "utf8");
  const css = readFileSync(CSS_PATH, "utf8");
  const region = sliceFunnel(html);
  let checks = 0;
  const ok = (cond: boolean, what: string): void => {
    assert.ok(cond, what);
    checks += 1;
  };

  // ── One heading pair: the section h2, then the three stage names and
  //    the CTA ask as h3s (no per-component h2 sections any more — the
  //    funnel is ONE object, not three cards). ──
  assert.equal(
    (region.match(/<h2\b/g) ?? []).length,
    1,
    "product section renders exactly one h2 (One Revenue Engine. Three Core Components.)",
  );
  checks += 1;
  assert.equal(
    (region.match(/<h3\b/g) ?? []).length,
    4,
    "exactly four h3s: three stage product names + the CTA ask line",
  );
  checks += 1;

  // ── The funnel object: three stages in engine order, then the plaque
  //    as the terminal result (markup order = visual order = story). ──
  const stageIds = [
    ...region.matchAll(/data-fn-stage="([a-z]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    stageIds,
    ["casegen", "caseintake", "caseconvert"],
    "three funnel stages in engine order",
  );
  checks += 1;
  const plaqueAt = region.indexOf("data-fn-plaque");
  ok(plaqueAt >= 0, "SIGNED CASES plaque present");
  ok(
    plaqueAt > region.lastIndexOf("data-fn-stage"),
    "plaque follows the last stage (the result, not a fourth stage)",
  );
  ok(region.includes("SIGNED CASES"), "plaque carries the SIGNED CASES label");

  // ── Decorative surface: numerals + engraved emblems are aria-hidden
  //    (screen readers get dept → name → headline → capabilities only),
  //    and the emblem SVGs carry no text of their own. ──
  assert.equal(
    (region.match(/class="nb-fn-num" aria-hidden="true"/g) ?? []).length,
    3,
    "three aria-hidden stage numerals",
  );
  checks += 1;
  assert.equal(
    (region.match(/class="nb-fn-art" aria-hidden="true"/g) ?? []).length,
    3,
    "three aria-hidden engraved emblems",
  );
  checks += 1;
  ok(!/<svg[^>]*>[\s\S]*?<text/.test(region), "emblem SVGs are text-free");
  ok(!region.includes("<img"), "funnel is imagery-free (inline SVG only)");

  // ── Single CTA: the section's only booking button, pointing at the
  //    stable homepage booking destination (per-product CTAs are on the
  //    brief's remove list). ──
  const buttons = region.match(/class="nb-btn[^"]*"/g) ?? [];
  assert.equal(buttons.length, 1, "exactly one button in the product section");
  checks += 1;
  ok(
    /class="nb-btn nb-fn-book" href="#booking"/.test(region),
    "the funnel CTA books the session",
  );

  // ── Served state is FINAL: no dash/draw machinery, no inline dimming
  //    (the illumination custom properties are runtime-only writes). ──
  ok(
    !region.includes("stroke-dasharray"),
    "no stroke-dasharray in served markup — nothing waits for a draw",
  );
  ok(
    !region.includes("--fn-"),
    "no inline --fn-* custom properties in served markup — dimming is runtime-only",
  );

  // ── No retired machinery in the region or the page ──
  ok(!html.includes("<canvas"), "no canvas anywhere on the homepage");
  for (const banned of [
    "data-mode=",
    "data-presentation=",
    "data-frame-base",
    "revenue-engine/frames",
    "rev-engine_",
    // #4992: the engine-story runtime hooks left with their markup:
    "data-es-",
    // #4925: the proof slider's state attributes stay out — that band is
    // fully static now. (The testimonials marquee's mode stamp left this
    // list with the #4980 restore: the band's lockstep comment names the
    // attribute again, and the stamp itself stays runtime-only — the
    // semantic-content suite still proves the served grids are complete.)
    "data-proof-",
    // #4987: the REE score strip left the homepage whole — its band
    // attribute/class family and anchor id stay out:
    "data-ree-",
    "nb-ree",
    'id="ree"',
    // #5016 (owner request): the #4926 session-offer band (HOW WORKING
    // TOGETHER STARTS + the you-leave-knowing card) left the homepage
    // whole — its class family stays out of the served markup, comments
    // included:
    "nb-offer",
  ]) {
    ok(!html.includes(banned), `frame/presentation machinery stays out of HTML: ${banned}`);
  }

  // ── Stylesheet contract: the funnel geometry ships, its scroll-focus
  //    overlays default LIT, and CSS never keys on the module handles. ──
  ok(
    /\.nb-fn-body\s*\{[^}]*clip-path:\s*polygon/.test(css),
    "funnel body carries the outer clip-path trapezoid",
  );
  ok(
    /\.nb-fn-stack\s*\{[^}]*clip-path:\s*polygon/.test(css),
    "stage stack carries the inset clip-path (the gold sliver IS the continuous border)",
  );
  ok(
    css.includes("var(--fn-veil,0)") && css.includes("var(--fn-lume,0)"),
    "stage overlays read --fn-veil/--fn-lume with LIT fallbacks (0 = complete served state)",
  );
  ok(
    !css.includes("var(--fn-glow") &&
      css.includes("0 0 34px rgba(213,172,92,.5)"),
    "SIGNED CASES plaque keeps its static resting halo while stage focus moves above",
  );
  ok(
    !css.includes("data-fn-"),
    "no CSS rule keys on data-fn-* — those are module handles + the QA stamp only",
  );
  const stickyDeclarations = css.match(/position:\s*sticky/g) ?? [];
  assert.equal(
    stickyDeclarations.length,
    0,
    "the homepage has no sticky conversion dependency",
  );
  checks += 1;
  ok(
    !css.includes(".nb-calendly-recovery"),
    "the retired Calendly recovery bar stays absent",
  );
  for (const banned of [
    ".rec-",
    "nb-tuned",
    "revenue-engine",
    "position: fixed",
    "nb-handoff",
    "nb-recap",
    // #4992 (owner funnel brief): the engine-story families — charcoal
    // overview, component sections + sticky index, the shared diagram
    // language, and the customization band — left with the redesign:
    ".nb-system",
    ".nb-comps",
    ".nb-comp",
    ".nb-dg",
    ".nb-custom",
    // #4925 (owner brief §§7–9): the proof slider chrome, its rate
    // cards, the Burns ramp + Expansion ladder families, and the REE
    // example/connection rules left with their bands. (The testimonials
    // marquee family returned with the #4980 restore, so its stems left
    // this list.)
    ".nb-proof-track",
    ".nb-proof-nav",
    ".nb-proof-slide",
    ".nb-proof-dot",
    ".nb-rate",
    ".nb-bs-",
    ".nb-x-",
    // #4987 widened the #4925-era .nb-ree-example/.nb-ree-connect/
    // .nb-ree-model bans to the whole family: the REE strip band was
    // removed wholesale, so every dotted rule in its namespace stays out:
    ".nb-ree",
    // #5016: the session-offer band's rule family left at every
    // breakpoint with the band (base rules + the ≤520px card override):
    ".nb-offer",
  ]) {
    ok(
      !css.includes(banned),
      `retired cinematic/engine-story/#4925-band CSS stays out: ${banned}`,
    );
  }

  console.log(
    `OK website-engine-story-static-integrity: ${checks} markup/CSS assertions over ${HTML_PATH} + ${CSS_PATH}`,
  );
}

main();
