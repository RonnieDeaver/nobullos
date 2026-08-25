/* test-registration
{
  "name": "Comparison CSV download (Task #1160)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.4s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Unit test for the multi-step comparison CSV download helper used by the
 * admin Activity Dashboard's "Download CSV" button.
 *
 * The helper is exercised via the pure `buildMultiStepCsv` export so we can
 * assert on the produced CSV string directly without standing up jsdom or
 * triggering a real <a download> click.
 *
 * The fixtures cover:
 *  - header order (key column first, then a Step N timestamp + value column
 *    pair per entry, in chronological order),
 *  - per-step timestamp formatting via date-fns "yyyy-MM-dd HH:mm:ss" (the
 *    timestamp appears both in the header label and in every row's per-step
 *    timestamp column),
 *  - key formatting via the DiffConfig.formatKey hook,
 *  - value formatting via the DiffConfig.formatValue hook (including the
 *    `null` → "—" coercion used by the production configs),
 *  - CSV escaping for values containing commas, double quotes, and newlines
 *    (CRs, LFs, and CRLFs all force quoting; embedded quotes are doubled),
 *  - row ordering preserved from the supplied `multiStepRows` array,
 *  - line terminator (CRLF between header + each row, no trailing newline).
 */

import { format } from "date-fns";

import {
  buildMultiStepCsv,
  type DiffConfig,
  type MultiStepRow,
} from "../../client/src/pages/admin/ActivityDashboard";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

const TS1 = "2026-05-01T09:00:00.000Z";
const TS2 = "2026-05-08T14:30:15.000Z";
const TS3 = "2026-05-15T22:45:00.000Z";

const FMT1 = format(new Date(TS1), "yyyy-MM-dd HH:mm:ss");
const FMT2 = format(new Date(TS2), "yyyy-MM-dd HH:mm:ss");
const FMT3 = format(new Date(TS3), "yyyy-MM-dd HH:mm:ss");

const config: DiffConfig = {
  title: "Test config",
  keyHeader: "Field",
  formatKey: (k) => `key:${k}`,
  formatValue: (v) => (v == null ? "—" : String(v)),
};

const entries = [{ timestamp: TS1 }, { timestamp: TS2 }, { timestamp: TS3 }];

const rows: MultiStepRow[] = [
  {
    key: "alpha",
    cells: [
      { oldValue: null, newValue: 10, changed: true, stepDelta: null, differsFromPrevious: false },
      { oldValue: 10, newValue: 20, changed: true, stepDelta: 10, differsFromPrevious: true },
      { oldValue: 20, newValue: 30, changed: true, stepDelta: 10, differsFromPrevious: true },
    ],
  },
  {
    key: "comma,key",
    cells: [
      {
        oldValue: null,
        newValue: 'has, "quote" and\nnewline',
        changed: true,
        stepDelta: null,
        differsFromPrevious: false,
      },
      { oldValue: null, newValue: "plain", changed: true, stepDelta: null, differsFromPrevious: true },
      { oldValue: null, newValue: null, changed: false, stepDelta: null, differsFromPrevious: true },
    ],
  },
  {
    key: "with\rCR",
    cells: [
      { oldValue: null, newValue: "carriage\rreturn", changed: true, stepDelta: null, differsFromPrevious: false },
      { oldValue: null, newValue: "windows\r\nstyle", changed: true, stepDelta: null, differsFromPrevious: true },
      { oldValue: null, newValue: 'final"value', changed: true, stepDelta: null, differsFromPrevious: true },
    ],
  },
];

const csv = buildMultiStepCsv(config, entries, rows);

// --- Build expected CSV string explicitly --------------------------------
// Step-to-step delta columns appear after each i>0 step's value column
// (no delta column for step 1, which has no prior step to diff against).
const expectedHeader = [
  "Field",
  "Step 1 timestamp",
  `Step 1 value (${FMT1})`,
  "Step 2 timestamp",
  `Step 2 value (${FMT2})`,
  "Step 2 Δ",
  "Step 3 timestamp",
  `Step 3 value (${FMT3})`,
  "Step 3 Δ",
].join(",");

// Row 1: numeric values, alphabetically first key, no escaping needed.
// Numeric stepDelta values render as their plain string form.
const expectedRow1 = ["key:alpha", FMT1, "10", FMT2, "20", "10", FMT3, "30", "10"].join(",");

// Row 2: comma in formatted key forces quoting; complex value with comma +
// embedded double-quote + bare LF forces quoting and doubles the quotes;
// null value coerces to "—". stepDelta is null on both i>0 steps (string
// values) and renders as the empty string.
const expectedRow2 = [
  `"key:comma,key"`,
  FMT1,
  `"has, ""quote"" and\nnewline"`,
  FMT2,
  "plain",
  "",
  FMT3,
  "—",
  "",
].join(",");

// Row 3: CR / CRLF inside the key & values force quoting; a value with an
// embedded double quote gets the quote doubled. All stepDeltas are null
// (string values) so the delta column is empty for every i>0 step.
const expectedRow3 = [
  `"key:with\rCR"`,
  FMT1,
  `"carriage\rreturn"`,
  FMT2,
  `"windows\r\nstyle"`,
  "",
  FMT3,
  `"final""value"`,
  "",
].join(",");

const expectedCsv = [expectedHeader, expectedRow1, expectedRow2, expectedRow3].join("\r\n");

assertEqual(csv, expectedCsv, "buildMultiStepCsv output must match the expected header + row layout exactly");

// Belt-and-suspenders: explicit terminator + trailing-newline checks. The
// production helper wraps this string in a Blob — leaving a stray trailing
// newline would create an empty row in spreadsheets pasting the CSV.
assert(!csv.endsWith("\r\n") && !csv.endsWith("\n"), "csv must not have a trailing newline");
assert(csv.startsWith(expectedHeader + "\r\n"), "csv must terminate the header row with CRLF");

// --- formatValue hook is invoked for every cell -------------------------
// Sanity check: a config that uppercases values must affect every cell,
// and the null-coercion path is reached too.
const upperConfig: DiffConfig = {
  ...config,
  formatValue: (v) => (v == null ? "NULL" : String(v).toUpperCase()),
};
const upperCsv = buildMultiStepCsv(upperConfig, entries, [
  {
    key: "z",
    cells: [
      { oldValue: null, newValue: "abc", changed: true, stepDelta: null, differsFromPrevious: false },
      { oldValue: null, newValue: null, changed: false, stepDelta: null, differsFromPrevious: false },
      { oldValue: null, newValue: "def", changed: true, stepDelta: null, differsFromPrevious: true },
    ],
  },
]);
// stepDelta is null on every cell of this fixture (string/null values), so
// the i>0 delta columns render as the empty string.
const expectedUpperRow = ["key:z", FMT1, "ABC", FMT2, "NULL", "", FMT3, "DEF", ""].join(",");
assertEqual(
  upperCsv.split("\r\n", 2)[1],
  expectedUpperRow,
  "formatValue must be applied to every cell (including null coercion)",
);

// --- Row ordering: rows appear in the order supplied --------------------
// The production caller passes rows produced by `buildMultiStepComparisonRows`,
// which sorts keys alphabetically. The helper itself must preserve the
// caller's order, so feeding rows in reverse must produce them in reverse.
const reversedCsv = buildMultiStepCsv(config, entries, [...rows].reverse());
const reversedExpected = [expectedHeader, expectedRow3, expectedRow2, expectedRow1].join("\r\n");
assertEqual(reversedCsv, reversedExpected, "row order must follow the supplied multiStepRows order");

console.log("comparison-csv-download: all CSV cases passed");
