/* test-registration
{
  "name": "Website homepage anchors — product-stage deep links plus the stable #booking and #contact conversion destinations resolve uniquely",
  "smoke": true,
  "smokeReason": "Guards the homepage fragment contract: #system and the three product stages remain unique, while every homepage session CTA targets the unique #booking scheduler and the homepage footer Contact link targets the unique #contact form. It also keeps depth-correct shared footer links, the focused book utilities chrome-free, #proof, and the retired REE target intact. A heading, id, or relative-link drift fails in under a second with no DB.",
  "regression": true,
  "scanPaths": ["website/public", "website/src/html.ts", "website/src/pages/home.ts"],
  "tier": "small"
}
test-registration */
// Anchor/navigation guard for the overall #system product section and the
// three stable component-stage fragments introduced for the footer. It checks
// the committed generator output at every route depth, including nested
// resource pages, without adding a second browser suite.
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = "website/public";
const HTML_PATH = join(PUBLIC_DIR, "index.html");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const COMPONENTS = [
  { id: "casegen", label: "CaseGen™" },
  { id: "caseintake", label: "CaseIntake™" },
  { id: "caseconvert", label: "CaseConvert™" },
] as const;

function generatedIndexPaths(
  dir = PUBLIC_DIR,
  relativeDir = "",
): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...generatedIndexPaths(join(dir, entry.name), relativePath));
    } else if (entry.isFile() && entry.name === "index.html") {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

function main(): void {
  const html = readFileSync(HTML_PATH, "utf8");
  let checks = 0;
  const ok = (cond: boolean, what: string): void => {
    assert.ok(cond, what);
    checks += 1;
  };

  // ── The #system target: exactly one, on the product-section funnel ──
  assert.equal(
    countOf(html, 'id="system"'),
    1,
    'id="system" appears exactly once on the homepage',
  );
  ok(
    html.includes('<section id="system" class="nb-funnel"'),
    "the #system id lives on the product-section funnel",
  );
  ok(
    html.includes('aria-labelledby="nb-funnel-head"') &&
      html.includes('id="nb-funnel-head"'),
    "the funnel section is labelled by its own headline",
  );

  // ── Homepage header target and the independent OUR SERVICES footer contract ──
  ok(
    html.includes(
      '<a href="about/#practice-areas-served">Practice Areas Served</a>',
    ),
    "header Practice Areas Served link targets the About-page section",
  );
  // Task #5017: the hero secondary is the book-funnel entry now. The
  // single-class outlined anchor is uniquely the hero button — the
  // header/menu/footer book CTAs carry placement classes (nb-nav-book,
  // nb-menu-book, nb-footer-book) beside nb-btn-outline.
  ok(
    /<a class="nb-btn-outline" href="free-chapters\/">Read the Book/.test(html),
    "hero secondary is the Read the Book button into free-chapters/ (Task #5017)",
  );
  ok(
    !/<a class="nb-btn-outline" href="#system">/.test(html),
    "the hero outlined button no longer targets #system (Task #5017 relabel)",
  );
  assert.equal(
    countOf(html, "<h4>OUR SERVICES</h4>"),
    1,
    "homepage footer uses the OUR SERVICES heading exactly once",
  );
  assert.equal(
    countOf(html, 'href="#system"'),
    1,
    "only the footer Revenue Engine targets overall #system",
  );
  ok(
    html.includes('<a href="#system">The Revenue Engine™</a>'),
    "footer Revenue Engine link keeps the overall #system destination",
  );
  ok(
    !/href="[^"]*services\/?"/.test(html),
    "homepage has no internal link to the retired services route",
  );

  // Each footer component resolves to one uniquely named stage. The old
  // comp-* engine-story ids and sticky-index hooks remain retired.
  for (const component of COMPONENTS) {
    assert.equal(
      countOf(html, `id="${component.id}"`),
      1,
      `#${component.id} target appears exactly once`,
    );
    ok(
      html.includes(
        `<div id="${component.id}" class="nb-fn-stage`,
      ) &&
        html.includes(`data-fn-stage="${component.id}"`),
      `#${component.id} resolves to the ${component.label} funnel stage`,
    );
    ok(
      html.includes(
        `<a href="#${component.id}">${component.label}</a>`,
      ),
      `homepage footer ${component.label} link targets #${component.id}`,
    );
  }
  for (const gone of ["id=\"comp-case", "data-es-idx=", "data-es-comp="]) {
    ok(!html.includes(gone), `retired engine-story anchor stays out: ${gone}`);
  }

  // ── #4925 zone anchors: the static proof band keeps its id (header
  //    Results link). The REE strip's id="ree" left with the strip band
  //    (Task #4987 — zero REE mentions on the homepage) and must stay
  //    gone. ──
  assert.equal(
    countOf(html, 'id="proof"'),
    1,
    'id="proof" appears exactly once on the homepage',
  );
  ok(
    html.includes('<section id="proof" class="nb-proof">'),
    "the #proof id lives on the static proof band",
  );
  ok(
    html.includes('<a href="#proof">Results</a>'),
    "header Results link targets #proof",
  );
  assert.equal(
    countOf(html, 'id="ree"'),
    0,
    'id="ree" stays off the homepage — the REE strip band was removed by Task #4987',
  );

  // ── Homepage conversion hub: unique sticky-header-safe fragments. Every
  //    homepage booking CTA now stays on-page; legacy conversion routes remain
  //    available to shared subpages but are no longer homepage destinations. ──
  for (const [id, sectionClass] of [
    ["booking", "nb-conversion-booking"],
    ["contact", "nb-conversion-contact"],
  ] as const) {
    assert.equal(
      countOf(html, `id="${id}"`),
      1,
      `#${id} appears exactly once on the homepage`,
    );
    ok(
      html.includes(`<section id="${id}" class="${sectionClass}"`),
      `#${id} lives on its conversion-hub section`,
    );
  }
  const sessionLinks =
    html.match(/<a\b[^>]*href="[^"]*"[^>]*>Book (?:a|Your) High Impact Revenue Session/g) ?? [];
  assert.equal(sessionLinks.length, 6, `homepage exposes its six direct session CTA set (${sessionLinks.length})`);
  ok(
    sessionLinks.every((link) => link.includes('href="#booking"')),
    "every homepage session CTA lands at #booking",
  );
  ok(
    !/<a\b[^>]*href="book-free-demo\/"/.test(html),
    "homepage emits no legacy booking-page CTA",
  );
  ok(
    html.includes('<a href="#contact">Contact</a>'),
    "homepage footer Contact link lands at #contact",
  );

  // ── The About target appears once, and every generated subpage (including
  //    nested resources) uses exact depth-correct header and footer hrefs. ──
  const aboutHtml = readFileSync(join(PUBLIC_DIR, "about", "index.html"), "utf8");
  assert.equal(
    countOf(aboutHtml, 'id="practice-areas-served"'),
    1,
    "the About-page Practice Areas Served target appears exactly once",
  );
  const subpages = generatedIndexPaths().filter((path) => path !== "index.html");
  const focusedBookUtilityPages = new Set([
    "book/access/index.html",
    "book/apply/index.html",
    "book/bonus/index.html",
    "book/checkout/index.html",
    "book/index.html",
    "book/order-status/index.html",
    "book/thanks/index.html",
  ]);
  ok(subpages.length >= 20, `generated subpages found (${subpages.length})`);
  for (const page of subpages) {
    const sub = readFileSync(join(PUBLIC_DIR, page), "utf8");
    if (focusedBookUtilityPages.has(page)) {
      assert.equal(
        countOf(sub, 'data-site-header-contract="focused-funnel"'),
        1,
        `${page} declares the focused-funnel chrome contract exactly once`,
      );
      assert.equal(
        countOf(sub, "<h4>OUR SERVICES</h4>"),
        0,
        `${page} intentionally omits the global services footer`,
      );
      ok(
        !sub.includes("Practice Areas Served") &&
          !sub.includes("The Revenue Engine™"),
        `${page} keeps global funnel navigation out of the purchase utility`,
      );
      continue;
    }
    const routeDepth = page.split(/[\\/]/).filter(Boolean).length - 1;
    const prefix = "../".repeat(routeDepth);
    assert.equal(
      countOf(sub, "<h4>OUR SERVICES</h4>"),
      1,
      `${page} footer uses the OUR SERVICES heading exactly once`,
    );
    ok(
      sub.includes(
        `<a href="${prefix}about/#practice-areas-served">Practice Areas Served</a>`,
      ),
      `${page} header Practice Areas Served href resolves to the About-page target`,
    );
    ok(
      sub.includes(
        `<a href="${prefix}#system">The Revenue Engine™</a>`,
      ),
      `${page} footer Revenue Engine href resolves to homepage #system`,
    );
    ok(
      !/href="[^"]*services\/?"/.test(sub),
      `${page} has no internal link to the retired services route`,
    );
    // Task #5092: retired /book-free-demo/ and /contact/ must not appear as
    // live hrefs; shared session CTAs use the depth-correct #booking anchor.
    ok(
      !/href="[^"]*book-free-demo\/"/.test(sub),
      `${page} has no live href to the retired /book-free-demo/ route`,
    );
    ok(
      !/href="[^"]*\/contact\/"/.test(sub),
      `${page} has no live href to the retired /contact/ route`,
    );
    ok(
      sub.includes(`href="${prefix}#booking"`),
      `${page} shared session CTA uses depth-correct homepage #booking anchor`,
    );
    ok(
      sub.includes(`<a href="${prefix}#contact">Contact</a>`),
      `${page} shared footer Contact link uses depth-correct homepage #contact anchor`,
    );
    for (const component of COMPONENTS) {
      ok(
        sub.includes(
          `<a href="${prefix}#${component.id}">${component.label}</a>`,
        ),
        `${page} footer ${component.label} href resolves to homepage #${component.id}`,
      );
    }
  }

  console.log(
    `OK website-engine-story-anchors: ${checks} anchor assertions over the homepage + ${subpages.length} subpages`,
  );
}

main();
