/* test-registration
{
  "name": "Rendered-test console-noise filter guard (Task #2827)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #2827: the rendered-test console-noise filter guard. Task #2823's shared filter (tests/client/console-noise-filter.mjs) drops the two known-benign jsdom SVG warning shapes from every rendered test run \u2014 a broadened regex or a non-SVG allow-list entry would silently swallow REAL React warnings (missing keys, act() violations, wrong tags), which is invisible by definition. This test asserts the benign shapes ARE dropped, real warnings still print, patterns stay anchored, install is idempotent, and every allow-listed tag is SVG-only. Fast, DB-free, deterministic; the Validate workflow's npm run gate includes this SMOKE_FILES coverage.",
  "scanPaths": [
    "tests/client/console-noise-filter.mjs"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #2827 — Guard test for tests/client/console-noise-filter.mjs.
 *
 * Task #2823 added a shared console filter that drops the two known-benign
 * jsdom SVG warning shapes ("<linearGradient /> is using incorrect casing",
 * "The tag <stop> is unrecognized in this browser...") from rendered
 * PublicReport test runs. The filter is deliberately narrow (explicit SVG tag
 * allow-list, anchored patterns), but nothing locked that narrowness: a
 * future edit that broadens a regex or adds a non-SVG tag to the allow-list
 * could silently swallow REAL React warnings — exactly the failure the filter
 * existed to prevent (the Task #2813 missing-key warning was nearly invisible
 * in the SVG-noise flood).
 *
 * Proves:
 *   1. The two benign shapes ARE dropped for allow-listed SVG tags, both as
 *      pre-substituted strings and as React-style `%s` format-arg calls, on
 *      BOTH console.error and console.warn.
 *   2. Real warnings still print:
 *      - the missing-key warning,
 *      - an unrecognized NON-SVG tag (both plain and `%s` form),
 *      - a tag whose name merely STARTS with an allow-listed one (<stopwatch>),
 *      - a miscased PascalCase component,
 *      - an act() violation,
 *      - arbitrary console.warn / console.error lines,
 *      and non-string args are forwarded to the underlying console untouched.
 *   3. The patterns are anchored: a benign shape embedded mid-string (after a
 *      real message) still prints.
 *   4. Installation is idempotent: a cache-busted re-import does not re-wrap
 *      console.error/console.warn (function identity is unchanged), and
 *      behavior is unchanged after the re-import.
 *   5. Source-level narrowness lock: every entry in the filter's
 *      BENIGN_SVG_TAGS allow-list is a known SVG-ONLY element name (never a
 *      valid HTML tag like div/span/button), so the allow-list cannot quietly
 *      grow to swallow warnings about real HTML markup.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";

let passed = 0;
let failed = 0;

// The filter wraps console.error/console.warn on import, so assertions must
// report through pristine references captured BEFORE anything is replaced.
const realLog = console.log.bind(console);
const realError = console.error.bind(console);
const realWarn = console.warn.bind(console);

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    realLog(`  ✓ ${msg}`);
  } else {
    failed++;
    realError(`  ✗ ${msg}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FILTER_PATH = join(HERE, "client", "console-noise-filter.mjs");
const FILTER_URL = `file://${FILTER_PATH}`;

type Recorded = { method: "error" | "warn"; message: string; args: unknown[] };
const recorded: Recorded[] = [];

// Spies installed BENEATH the filter: the filter binds whatever
// console.error/warn are at import time, so anything it lets through lands
// here instead of the terminal.
const spyError = (...args: unknown[]) => {
  recorded.push({ method: "error", message: util.format(...args), args });
};
const spyWarn = (...args: unknown[]) => {
  recorded.push({ method: "warn", message: util.format(...args), args });
};

console.error = spyError;
console.warn = spyWarn;

await import(FILTER_URL);

const wrappedError = console.error;
const wrappedWarn = console.warn;

assert(
  wrappedError !== spyError && wrappedWarn !== spyWarn,
  "importing the filter wraps console.error and console.warn",
);

function through(fn: () => void): Recorded[] {
  recorded.length = 0;
  fn();
  return recorded.slice();
}

// ---------------------------------------------------------------------------
// 1. Benign shapes are dropped for allow-listed SVG tags.
// ---------------------------------------------------------------------------
const UNRECOGNIZED_SUFFIX =
  " If you meant to render a React component, start its name with an uppercase letter.";
const CASING_SUFFIX =
  " Use PascalCase for React components, or lowercase for HTML elements.";

for (const tag of ["stop", "linearGradient", "clipPath", "feGaussianBlur"]) {
  const out = through(() => {
    console.error(
      `The tag <${tag}> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  });
  assert(
    out.length === 0,
    `pre-substituted "unrecognized tag" warning for <${tag}> is dropped`,
  );
}

assert(
  through(() => {
    console.error(
      `Warning: The tag <%s> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}%s`,
      "stop",
      "\n    at stop\n    at PublicReport",
    );
  }).length === 0,
  'React-style %s-format "unrecognized tag" call for <stop> is dropped',
);

assert(
  through(() => {
    console.error(
      `<linearGradient /> is using incorrect casing.${CASING_SUFFIX}`,
    );
  }).length === 0,
  'pre-substituted "incorrect casing" warning for <linearGradient /> is dropped',
);

assert(
  through(() => {
    console.error(
      `Warning: <%s /> is using incorrect casing.${CASING_SUFFIX}%s`,
      "radialGradient",
      "\n    at radialGradient",
    );
  }).length === 0,
  'React-style %s-format "incorrect casing" call for <radialGradient /> is dropped',
);

assert(
  through(() => {
    console.warn(
      `The tag <defs> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  }).length === 0,
  "benign shape is dropped on console.warn too (both methods are filtered)",
);

// ---------------------------------------------------------------------------
// 2. Real warnings still print.
// ---------------------------------------------------------------------------
{
  const out = through(() => {
    console.error(
      'Warning: Each child in a list should have a unique "key" prop.%s%s See https://reactjs.org/link/warning-keys for more information.%s',
      "\n\nCheck the render method of `ReviewPanel`.",
      "",
      "\n    at div",
    );
  });
  assert(
    out.length === 1 && out[0].message.includes('unique "key" prop'),
    "the missing-key warning still prints",
  );
}

assert(
  through(() => {
    console.error(
      `The tag <sparkline> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  }).length === 1,
  "an unrecognized NON-SVG tag (<sparkline>) still prints",
);

assert(
  through(() => {
    console.error(
      `Warning: The tag <%s> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}%s`,
      "marquee",
      "\n    at marquee",
    );
  }).length === 1,
  "%s-format unrecognized NON-SVG tag (<marquee>) still prints",
);

assert(
  through(() => {
    console.error(
      `The tag <stopwatch> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  }).length === 1,
  "a tag merely PREFIXED by an allow-listed name (<stopwatch>) still prints",
);

assert(
  through(() => {
    console.error(
      `<ReviewChart /> is using incorrect casing.${CASING_SUFFIX}`,
    );
  }).length === 1,
  "a miscased PascalCase component (<ReviewChart />) still prints",
);

assert(
  through(() => {
    console.error(
      "Warning: An update to %s inside a test was not wrapped in act(...).",
      "PublicReport",
    );
  }).length === 1,
  "an act() violation still prints",
);

assert(
  through(() => {
    console.warn("slow query: getReviewVelocity took 4123ms");
  }).length === 1,
  "an arbitrary console.warn still prints",
);

{
  const payload = { code: "E_TIMEOUT", attempts: 3 };
  const out = through(() => {
    console.error("request failed", payload);
  });
  assert(
    out.length === 1 && out[0].args[1] === payload,
    "non-string args pass through to the underlying console untouched",
  );
}

// ---------------------------------------------------------------------------
// 3. Patterns are anchored — benign shape embedded mid-string still prints.
// ---------------------------------------------------------------------------
assert(
  through(() => {
    console.error(
      `Real failure context: The tag <stop> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  }).length === 1,
  "a benign shape embedded AFTER real text still prints (patterns are anchored)",
);

// ---------------------------------------------------------------------------
// 4. Idempotent installation — cache-busted re-import does not re-wrap.
// ---------------------------------------------------------------------------
await import(`${FILTER_URL}?reimport`);
assert(
  console.error === wrappedError && console.warn === wrappedWarn,
  "re-importing the filter (cache-busted) does not re-wrap console methods",
);
assert(
  through(() => {
    console.error(
      `The tag <stop> is unrecognized in this browser.${UNRECOGNIZED_SUFFIX}`,
    );
  }).length === 0 &&
    through(() => {
      console.error("still a real error after reimport");
    }).length === 1,
  "behavior is unchanged after the re-import (benign dropped, real printed)",
);

// ---------------------------------------------------------------------------
// 5. Source-level narrowness lock on the allow-list.
// ---------------------------------------------------------------------------
// Every allow-listed name must be an SVG-ONLY element (per the SVG spec,
// excluding any name that is also a valid HTML element). Adding a legitimate
// SVG-only tag later passes; adding div/span/button/table/etc. fails here.
const SVG_ONLY_ELEMENTS = new Set([
  "animate", "animateMotion", "animateTransform", "circle", "clipPath",
  "defs", "desc", "ellipse", "feBlend", "feColorMatrix",
  "feComponentTransfer", "feComposite", "feConvolveMatrix",
  "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow",
  "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur",
  "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset",
  "fePointLight", "feSpecularLighting", "feSpotLight", "feTile",
  "feTurbulence", "filter", "foreignObject", "g", "linearGradient", "marker",
  "mask", "metadata", "mpath", "path", "pattern", "polygon", "polyline",
  "radialGradient", "rect", "set", "stop", "switch", "symbol", "text",
  "textPath", "tspan", "use", "view",
]);

const filterSource = readFileSync(FILTER_PATH, "utf8");
const allowListMatch = filterSource.match(
  /const BENIGN_SVG_TAGS = \[([\s\S]*?)\];/,
);
assert(
  allowListMatch != null,
  "BENIGN_SVG_TAGS allow-list is present and parseable in the filter source",
);
if (allowListMatch) {
  const entries = Array.from(allowListMatch[1].matchAll(/"([^"]+)"/g)).map(
    (m) => m[1],
  );
  assert(
    entries.length > 0,
    `allow-list has entries (found ${entries.length})`,
  );
  const nonSvg = entries.filter((e) => !SVG_ONLY_ELEMENTS.has(e));
  assert(
    nonSvg.length === 0,
    nonSvg.length === 0
      ? "every allow-listed tag is a known SVG-only element name"
      : `allow-list contains non-SVG-only entries: ${nonSvg.join(", ")}`,
  );
}

// Restore the real console before summarizing.
console.error = realError;
console.warn = realWarn;

realLog(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
