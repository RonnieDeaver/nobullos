// Task #866 — Test-only shim for the `rrule` package.
//
// rrule's package.json points `main` at a webpack UMD bundle
// (`dist/es5/rrule.js`). Under Vite/esbuild that's transparently
// rewritten with CJS↔ESM interop, so `import { RRule } from "rrule"` in
// `client/src/components/booking/RecurrenceBuilder.tsx` "just works"
// in the app. Plain Node ESM has no such interop layer, so the same
// named import throws `does not provide an export named 'RRule'` when
// tsx evaluates the file. This shim re-publishes the names via
// createRequire so the tests can mount the real component graph
// without forking it.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("rrule");

export const RRule = pkg.RRule;
export const RRuleSet = pkg.RRuleSet;
export const rrulestr = pkg.rrulestr;
export const Frequency = pkg.Frequency;
export const Weekday = pkg.Weekday;
export const ALL_WEEKDAYS = pkg.ALL_WEEKDAYS;
export const datetime = pkg.datetime;
export default pkg;
