// Task #2823 — silence the known-benign jsdom SVG noise that floods every
// rendered PublicReport test run.
//
// The rendered-test harness shims recharts chart containers to plain <div>s
// (review-velocity-render-loader.mjs), so PublicReport's raw SVG gradient
// markup (<defs>/<linearGradient>/<stop>) renders in HTML context. React DOM
// then warns for every such element:
//   - "The tag <stop> is unrecognized in this browser. ..."
//   - "<linearGradient /> is using incorrect casing. ..."
// These are harmless artifacts of the jsdom/shim environment, but dozens of
// them per run bury REAL React warnings (the Task #2813 missing-key warning
// was nearly invisible in the flood).
//
// This module self-installs (idempotently) on import and drops ONLY those two
// warning shapes, and only for an explicit allow-list of SVG element names.
// Every other console.error / console.warn line passes through untouched —
// real React warnings (missing keys, act() violations, prop-type issues,
// unknown NON-SVG tags) must stay visible.
//
// It is imported by the generated recharts shim in
// review-velocity-render-loader.mjs, so every rendered test that registers
// that loader (directly or via report-decimal-save-display-setup.mjs) gets
// the filter with no per-test wiring.

import util from "node:util";

// SVG-only element names that legitimately appear in the report component
// tree's inline gradient/filter markup. Deliberately narrow: an unrecognized
// or miscased tag OUTSIDE this list is a real bug signal and must print.
const BENIGN_SVG_TAGS = [
  "defs",
  "stop",
  "linearGradient",
  "radialGradient",
  "clipPath",
  "textPath",
  "foreignObject",
  "feGaussianBlur",
  "feOffset",
  "feMerge",
  "feMergeNode",
  "feColorMatrix",
  "feDropShadow",
];

const TAG_ALT = BENIGN_SVG_TAGS.join("|");

// React may prefix dev warnings with "Warning: " depending on version/path.
const BENIGN_PATTERNS = [
  new RegExp(
    `^(?:Warning: )?The tag <(?:${TAG_ALT})> is unrecognized in this browser\\.`,
  ),
  new RegExp(
    `^(?:Warning: )?<(?:${TAG_ALT}) /> is using incorrect casing\\.`,
  ),
];

// React calls console.error("The tag <%s> is unrecognized...", tag, ...stack)
// — format the args the same way Node's console would before matching, so the
// substituted tag name is what the allow-list sees.
function isBenign(args) {
  try {
    const message = util.format(...args);
    return BENIGN_PATTERNS.some((re) => re.test(message));
  } catch {
    return false;
  }
}

const INSTALL_FLAG = "__nobullJsdomSvgNoiseFilterInstalled";

if (!globalThis[INSTALL_FLAG]) {
  globalThis[INSTALL_FLAG] = true;
  for (const method of ["error", "warn"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      if (isBenign(args)) return;
      original(...args);
    };
  }
}
