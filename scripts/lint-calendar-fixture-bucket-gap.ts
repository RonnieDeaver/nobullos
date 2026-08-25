/**
 * Task #4207 — Guard against calendar-schedule test failures from NOW()-relative
 * fixture pairs feeding calendar month/week bucket assertions.
 *
 * Background: a test that seeds two `daysAgo(N)` fixtures and then asserts a
 * month filter separates them will go red only in the first days of a calendar
 * month (when both fixtures land in the same YYYY-MM). The failure is
 * intermittent, mis-attributed to innocent task branches, and the green
 * baseline published mid-month shows main was clean — making the true cause
 * invisible.  See `.agents/memory/calendar-month-fixture-collision.md` and
 * `audits/date-fixture-bucket-sweep-2026-08-10.md`.
 *
 * The lint flags test files that combine:
 *   SEEDING  — NOW()-relative fixture timestamps:
 *                `daysAgo(N)`, `make_interval(`, `interval '…day…'`,
 *                `subDays(date, N)`, `.setDate(`, `hoursAgo(`, `monthsAgo(`,
 *                `.setMonth(` (second grep net, Task #4248)
 *   BUCKET   — calendar month/week bucket assertions:
 *                `'YYYY-MM'`/`"YYYY-MM"` format literals,
 *                `date_trunc('month'…)`, `date_trunc('week'…)`, `.slice(0, 7)`
 *
 * Verdict rules (applied in order):
 *   1. Suppressed — file contains `// calendar-fixture-gap-reviewed: <reason>`
 *      in the raw source → SKIP. The reason MUST name the specific fixture pairs
 *      confirmed safe; a future unrelated close pair should prompt a fresh review
 *      of the marker's scope.
 *   2. Non-extractable — file uses `make_interval(` or `interval '` seeding
 *      (gap is not statically visible) → REVIEW REQUIRED (co-occurrence flag).
 *   3. Extractable gap — all `daysAgo(N)` literal-integer calls are parsed.
 *      The required minimum gap depends on the bucket granularity present:
 *        month-level (YYYY-MM, date_trunc('month'), .slice(0,7)) → ≥60 days
 *        week-level  (date_trunc('week'), week_start)            → ≥13 days
 *                     (endpoints span ≥14 days: one week + 7-day margin)
 *      (both present → the stricter 60-day month threshold applies)
 *      - ≥2 values with ANY adjacent pair (in sorted order) gap < required → FAIL
 *        (any two close fixtures can collide into the same calendar bucket;
 *        a daysAgo(1)/daysAgo(6) pair shares an ISO week Mon–Sat).
 *      - All adjacent pairs gap ≥ required → PASS (every fixture pair is safely
 *        separated; an unrelated distant fixture cannot launder a close pair
 *        because ALL pairs are checked, not just the global spread).
 *      - 0 or 1 values → PASS (no pair to collide; co-occurrence is benign).
 *
 * WHY MIN-PAIRWISE-GAP, NOT MAX-SPREAD:
 *   Using max(daysAgo) - min(daysAgo) ≥ 60 would pass a file with daysAgo(10),
 *   daysAgo(15), daysAgo(70): the spread is 60 but the pair (10, 15) has only a
 *   5-day gap and CAN produce a same-month collision in the first 10 days of any
 *   month.  Checking every adjacent pair in sorted order catches this.
 *
 * Suppression: add a file-level comment (anywhere in the file) of the form
 *   // calendar-fixture-gap-reviewed: <specific reason naming the close pairs
 *   //   and why they are safe for month-separation assertions>
 * This is intentionally a human review checkpoint; do not reuse an existing
 * marker to cover new fixtures added later — update the reason to reflect the
 * full set of close pairs and their safety argument.
 *
 * ---------------------------------------------------------------------------
 * SECOND CHECK (Task #4433) — absolute future-date literal rot:
 *
 * A hardcoded literal like `dueDate: "2026-08-10"` that a suite asserts is
 * future/not-overdue goes red PERMANENTLY the moment that UTC date passes
 * (tests/save-plays.test.ts did exactly this at 2026-08-11 00:00 UTC), and the
 * last-published green manifest predates the rot, so attribution blames
 * innocent task branches. See the "Variant" section of
 * `.agents/memory/calendar-month-fixture-collision.md` and
 * `audits/absolute-future-date-literal-sweep-2026-08-12.md`.
 *
 * Rule: any quoted YYYY-MM-DD literal in a test file whose date is strictly
 * AFTER today (UTC) and within FUTURE_HORIZON_DAYS (3 years) is flagged as
 * `future_date_literal` unless the file carries a valid
 *   // future-date-literal-reviewed: <reason>
 * line-comment marker. The reason must say why the literal cannot rot
 * (pinned injected clock, literal-vs-literal comparison, pinned expansion
 * window, etc.).
 *
 * WHY A 3-YEAR HORIZON instead of flagging every future literal: deliberate
 * far-future sentinels ("2099-01-01" epoch floors, "2030-*" parked-window
 * fixtures) are a sanctioned pattern — they are compared against pinned
 * clocks or used as beyond-everything cursor bounds. The horizon lets them
 * pass today while guaranteeing the lint starts warning ~3 years BEFORE any
 * of them could rot, which is ample time to convert or review them.
 *
 * TIME DEPENDENCE: this check's verdict depends on the run date (a literal
 * enters the horizon as time passes). The lint green-verdict cache keys on
 * file bytes, not dates — with a 3-year warning window, cache staleness of
 * days or weeks is harmless.
 *
 * The fix pattern for genuine bombs is clock-derived offsets, e.g.
 *   const dueIn = (d: number) =>
 *     new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
 * with N ≥ 10 days (the UTC slice matches the DB's CURRENT_DATE in UTC
 * containers).
 *
 * Exit codes:
 *   0 — no offenders.
 *   1 — at least one offender (definite gap violation, unresolved
 *       co-occurrence, or unreviewed future-date literal).
 */

import { readFileSync } from "node:fs";
import {
  isScannablePath,
  listTrackedFiles,
  walkDir,
} from "./lintFileDiscovery";

const SELF = "lint-calendar-fixture-bucket-gap";

/** The suppress marker token — must appear in a `//` line comment with a non-empty reason. */
const SUPPRESS_MARKER = "calendar-fixture-gap-reviewed:";

/** Suppress marker for the future-date-literal check (Task #4433). Separate
 * from the gap marker — reviewing one hazard must never silence the other. */
const FUTURE_DATE_MARKER = "future-date-literal-reviewed:";

/** Future literals more than this many days out are treated as sanctioned
 * far-future sentinels (2030/2099 fixtures) and pass — until time brings them
 * inside the horizon, ~3 years before they could rot. */
const FUTURE_HORIZON_DAYS = 1095;

// ---------------------------------------------------------------------------
// Pattern sets
// ---------------------------------------------------------------------------

/** Patterns that indicate NOW()-relative fixture timestamp seeding. */
const SEEDING_PATTERNS: RegExp[] = [
  /\bdaysAgo\(/,
  /\bmake_interval\(/,
  /\binterval\s+'/,    // SQL interval literal:  interval '10 days'
  /\binterval\s+"/,    // SQL interval literal:  interval "10 days"
  // Second grep net (audits/date-fixture-bucket-sweep-2026-08-10.md §Method 1):
  /\bsubDays\(/,       // date-fns subDays(date, N) — N extractable (2nd arg)
  /\.setDate\(/,       // d.setDate(d.getDate() - N) — offset not statically visible
  /\bhoursAgo\(/,      // helper — sub-day offsets, not statically comparable in days
  /\bmonthsAgo\(/,     // helper — month arithmetic, gap depends on calendar month lengths
  /\.setMonth\(/,      // d.setMonth(d.getMonth() - N) — same
];

/**
 * Which seeding patterns produce non-extractable gaps (we cannot statically
 * read the numeric offset from them). Files that only have extractable
 * daysAgo(N) seeding are given the numeric gap check; files that also use
 * these patterns get the co-occurrence review flag.
 */
const NON_EXTRACTABLE_PATTERNS: RegExp[] = [
  /\bmake_interval\(/,
  /\binterval\s+'/,
  /\binterval\s+"/,
  /\.setDate\(/,   // mutating setter — the effective offset is an expression, not a literal
  /\bhoursAgo\(/,  // sub-day units; day-gap comparison would be misleading
  /\bmonthsAgo\(/, // month arithmetic — day-gap not statically derivable
  /\.setMonth\(/,  // mutating setter, month arithmetic
];

/**
 * Calendar month/week bucket assertion patterns.
 * Scoped to MONTH-level (YYYY-MM) and WEEK-level to avoid false positives
 * from day-separator tests that use day-granularity buckets only.
 */
const MONTH_BUCKET_PATTERNS: RegExp[] = [
  /'YYYY-MM'/,                              // SQL/format literal  'YYYY-MM'
  /"YYYY-MM"/,                              // format literal      "YYYY-MM"
  /date_trunc\(\s*'month'/,                // SQL date_trunc('month', ...)
  /date_trunc\(\s*"month"/,
  /\.slice\(\s*0\s*,\s*7\s*\)/,           // .toISOString().slice(0, 7) → YYYY-MM
];

/**
 * Week-level bucket assertion patterns. A close daysAgo pair (e.g. 1d vs 6d)
 * feeding a week bucket collides into the same ISO week whenever "today" is
 * Monday–Saturday — a WEEKLY failure schedule, far more frequent than the
 * month case. Week buckets get their own, tighter-but-lower threshold:
 * ≥14 days (one full week + a 7-day safety margin).
 */
const WEEK_BUCKET_PATTERNS: RegExp[] = [
  /date_trunc\(\s*'week'/,                 // SQL date_trunc('week', ...)
  /date_trunc\(\s*"week"/,
  /\bweek_start\b/,                        // week_start column/alias assertions
];

const BUCKET_PATTERNS: RegExp[] = [
  ...MONTH_BUCKET_PATTERNS,
  ...WEEK_BUCKET_PATTERNS,
];

/** Minimum safe daysAgo gap for month-level (YYYY-MM) bucket assertions. */
const MONTH_MIN_GAP_DAYS = 60;
/**
 * Minimum safe daysAgo GAP for week-level bucket assertions: 13, i.e. the two
 * endpoints span ≥14 distinct days (one full week + a 7-day safety margin).
 * ISO-week collision requires a gap ≤6, so a daysAgo(1)/daysAgo(14) pair
 * (gap 13) can never share a week bucket and passes.
 */
const WEEK_MIN_GAP_DAYS = 13;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTestFile(file: string): boolean {
  const segments = file.split("/");
  const base = segments[segments.length - 1];
  if (base.includes(SELF)) return false;
  if (segments.slice(0, -1).includes("helpers")) return false;
  return base.endsWith(".test.ts") || base.endsWith(".test.tsx");
}

/**
 * Strip `import … from "…"` / `import "…"` statements and both block and
 * line comments, so pattern matching only runs on executable code.
 */
function stripImportsAndComments(src: string): string {
  let s = src;
  s = s.replace(/\bimport\s+type\b[\s\S]*?from\s*['"][^'"]+['"];?/g, " ");
  s = s.replace(/\bimport\b[\s\S]*?from\s*['"][^'"]+['"];?/g, " ");
  s = s.replace(/\bimport\s*['"][^'"]+['"];?/g, " ");
  // Blank block comments (preserve newlines for line counting).
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Blank line comments.
  s = s
    .split("\n")
    .map((line) => {
      const i = line.indexOf("//");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
  return s;
}

/**
 * Extract all statically-visible day offsets:
 *   - daysAgo(N)        — N is the first (only) argument
 *   - subDays(expr, N)  — date-fns; N is the SECOND argument
 * Only plain non-negative integer literals are extracted; expressions like
 * daysAgo(x) or subDays(now, n + 1) are skipped (they fall back to the
 * co-occurrence rules).
 */
function extractDayOffsetValues(code: string): number[] {
  const values: number[] = [];
  const daysAgoRe = /\bdaysAgo\(\s*(\d+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = daysAgoRe.exec(code)) !== null) {
    values.push(parseInt(m[1], 10));
  }
  // subDays(<first arg without a comma>, <integer>) — the first argument may
  // contain parens (e.g. new Date()) but not a comma. Comma-bearing or
  // non-literal forms are NOT extracted here; countUnextractableSubDays()
  // detects them so the file is routed to review_required instead of
  // passing silently.
  const subDaysRe = /\bsubDays\(\s*[^,]*?,\s*(\d+)\s*\)/g;
  while ((m = subDaysRe.exec(code)) !== null) {
    values.push(parseInt(m[1], 10));
  }
  return values;
}

/**
 * Count subDays( call sites whose day offset is NOT statically extractable by
 * the regex above (nested comma-bearing first argument, e.g.
 * `subDays(startOfWeek(now, { weekStartsOn: 1 }), 10)`, or a non-literal
 * second argument). Any such call site makes the file's gap unverifiable and
 * must route it to review_required — otherwise two close fixtures would pass
 * silently.
 */
function countUnextractableSubDays(code: string): number {
  const total = (code.match(/\bsubDays\(/g) ?? []).length;
  // Same shape as the extraction regex above (kept in lockstep): first arg
  // without a comma, literal-integer second arg.
  const extractable = (code.match(/\bsubDays\(\s*[^,]*?,\s*\d+\s*\)/g) ?? []).length;
  return Math.max(0, total - extractable);
}
function hasAnyPattern(code: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(code));
}

/**
 * Return true when the raw source contains a VALID suppression marker.
 *
 * A valid marker MUST:
 *   1. Appear in a `//` line comment (not in a string literal, template
 *      literal, block comment, or any other position).
 *   2. Have a non-empty, non-whitespace reason after the colon — the reason
 *      should name the specific fixture pairs that were reviewed and why they
 *      are safe, but this function enforces non-emptiness only (content is a
 *      human-review responsibility).
 *
 * Invalid forms that are NOT accepted:
 *   - `// calendar-fixture-gap-reviewed:`       (empty reason — nothing after the colon)
 *   - a string literal containing the marker token
 *   - a block comment (slash-star ... star-slash) containing the marker token
 */
function hasValidSuppressMarker(raw: string, marker: string = SUPPRESS_MARKER): boolean {
  for (const line of raw.split("\n")) {
    const trimmed = line.trimStart();
    // Must be a line comment — first non-whitespace chars must be `//`.
    if (!trimmed.startsWith("//")) continue;
    const commentText = trimmed.slice(2); // strip the leading `//`
    const idx = commentText.indexOf(marker);
    if (idx === -1) continue;
    const reason = commentText.slice(idx + marker.length).trim();
    if (reason.length > 0) return true;
  }
  return false;
}

/**
 * Extract every quoted YYYY-MM-DD literal (including the date part of longer
 * ISO datetime strings) that parses as a real calendar date, with its 1-based
 * line number. Runs on stripped code so commented examples don't trip.
 */
function extractQuotedDateLiterals(code: string): Array<{ literal: string; line: number }> {
  const out: Array<{ literal: string; line: number }> = [];
  const lines = code.split("\n");
  const re = /['"`](\d{4})-(\d{2})-(\d{2})/g;
  for (let i = 0; i < lines.length; i++) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lines[i])) !== null) {
      const [, y, mo, d] = m;
      const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d));
      const dt = new Date(ts);
      // Reject non-dates like "2026-13-40" (Date.UTC would roll them over).
      if (
        dt.getUTCFullYear() !== Number(y) ||
        dt.getUTCMonth() !== Number(mo) - 1 ||
        dt.getUTCDate() !== Number(d)
      ) {
        continue;
      }
      out.push({ literal: `${y}-${mo}-${d}`, line: i + 1 });
    }
  }
  return out;
}

/** UTC midnight of "today" — comparable with Date.UTC of a YYYY-MM-DD literal. */
function todayUtcMidnight(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Return the minimum gap between any two values, computed over adjacent pairs
 * in sorted order (which gives the global minimum pairwise gap).
 *
 * Rationale: we use min-pairwise-gap, NOT max-spread (max−min).  A file with
 * daysAgo(10), daysAgo(15), daysAgo(70) has spread 60 but the pair (10,15)
 * has only a 5-day gap — the unrelated 70-day fixture must NOT launder the
 * close pair.  Min-pairwise-gap is the conservative choice: a file only
 * passes when EVERY pair of fixtures is safely separated by ≥60 days.
 */
function minPairwiseGap(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    min = Math.min(min, sorted[i] - sorted[i - 1]);
  }
  return min;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OffenderKind = "gap_violation" | "review_required" | "future_date_literal";

export interface Offender {
  file: string;
  kind: OffenderKind;
  reason: string;
}

// ---------------------------------------------------------------------------
// Core lint
// ---------------------------------------------------------------------------

export function runLint(root?: string): {
  ok: boolean;
  offenders: Offender[];
  scanned: number;
} {
  const files: string[] = [];
  if (root) {
    walkDir(root, files, isTestFile);
  } else {
    for (const f of listTrackedFiles()) {
      if (isScannablePath(f) && isTestFile(f)) files.push(f);
    }
  }

  const offenders: Offender[] = [];

  const today = todayUtcMidnight();

  for (const file of files) {
    const raw = readFileSync(file, "utf8");

    // ── Check 2 (Task #4433): absolute future-date literals ─────────────
    // Independent of the seeding/bucket co-occurrence below: a rotting
    // literal needs no NOW()-relative seeding to detonate.
    if (!hasValidSuppressMarker(raw, FUTURE_DATE_MARKER)) {
      const strippedForDates = stripImportsAndComments(raw);
      const hits = extractQuotedDateLiterals(strippedForDates).filter(({ literal }) => {
        const [y, mo, d] = literal.split("-").map(Number);
        const ts = Date.UTC(y, mo - 1, d);
        const daysOut = (ts - today) / 86_400_000;
        return daysOut > 0 && daysOut <= FUTURE_HORIZON_DAYS;
      });
      if (hits.length > 0) {
        const listed = hits
          .slice(0, 8)
          .map((h) => `${h.literal} (line ${h.line})`)
          .join(", ");
        offenders.push({
          file,
          kind: "future_date_literal",
          reason:
            `contains ${hits.length} quoted future-dated literal(s) within ${FUTURE_HORIZON_DAYS} days: ${listed}` +
            (hits.length > 8 ? ", …" : "") +
            `. Absolute literals asserted as future/not-overdue/upcoming rot PERMANENTLY at a ` +
            `fixed UTC midnight (tests/save-plays.test.ts went red this way at 2026-08-11 00:00 UTC) ` +
            `and get mis-attributed to innocent task branches. ` +
            `Fix: derive from the clock — const dueIn = (d: number) => new Date(Date.now() + d * 86_400_000)` +
            `.toISOString().slice(0, 10) with N ≥ 10 days (see tests/save-plays.test.ts). ` +
            `If the literal genuinely cannot rot (pinned injected clock, literal-vs-literal comparison, ` +
            `pinned recurrence/expansion window), suppress with:\n` +
            `  // ${FUTURE_DATE_MARKER} <name the literals and why they cannot rot>\n` +
            `See .agents/memory/calendar-month-fixture-collision.md (Variant section).`,
        });
      }
    }

    // Fast-path: file must have at least one seeding AND one bucket token.
    if (
      !hasAnyPattern(raw, SEEDING_PATTERNS) ||
      !hasAnyPattern(raw, BUCKET_PATTERNS)
    ) {
      continue;
    }

    // Check suppress marker — must be a valid // line comment with non-empty reason.
    if (hasValidSuppressMarker(raw)) continue;

    const code = stripImportsAndComments(raw);

    // Re-confirm co-occurrence in stripped code (eliminates matches in
    // comments and import paths).
    if (
      !hasAnyPattern(code, SEEDING_PATTERNS) ||
      !hasAnyPattern(code, BUCKET_PATTERNS)
    ) {
      continue;
    }

    const hasMonthBucket = hasAnyPattern(code, MONTH_BUCKET_PATTERNS);
    const hasWeekBucket = hasAnyPattern(code, WEEK_BUCKET_PATTERNS);
    // Required gap: month buckets need ≥60d; week-only buckets need ≥14d.
    // When BOTH bucket kinds appear, the stricter month threshold applies.
    const requiredGap = hasMonthBucket ? MONTH_MIN_GAP_DAYS : WEEK_MIN_GAP_DAYS;
    const bucketLabel = hasMonthBucket
      ? hasWeekBucket
        ? "month+week"
        : "month"
      : "week";

    // Non-extractable seeding → flag for human review. This includes
    // subDays( call sites whose offset the extractor cannot read (nested
    // comma-bearing first argument or non-literal second argument) — they
    // must not pass silently.
    if (
      hasAnyPattern(code, NON_EXTRACTABLE_PATTERNS) ||
      countUnextractableSubDays(code) > 0
    ) {
      offenders.push({
        file,
        kind: "review_required",
        reason:
          `uses non-extractable NOW()-relative seeding (make_interval()/interval '…'/` +
          `.setDate()/hoursAgo()/monthsAgo()/.setMonth()/non-literal subDays()) alongside a calendar month/week ` +
          `bucket assertion — gap cannot be statically verified. ` +
          `Confirm every fixture pair feeding the bucket assertion is ≥${requiredGap} days apart ` +
          `(or uses pinned absolute timestamps), then suppress with:\n` +
          `  // ${SUPPRESS_MARKER} <specific pairs confirmed safe and why>`,
      });
      continue;
    }

    // Extractable daysAgo(N)/subDays(_, N) gap check — min pairwise gap.
    const values = extractDayOffsetValues(code);
    if (values.length < 2) {
      // 0 or 1 extractable value — no pair to collide; pass.
      continue;
    }

    const gap = minPairwiseGap(values);
    const sorted = [...values].sort((a, b) => a - b);

    if (gap < requiredGap) {
      // Find the closest pair for the error message.
      let pairA = sorted[0];
      let pairB = sorted[1];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] === gap) {
          pairA = sorted[i - 1];
          pairB = sorted[i];
          break;
        }
      }
      offenders.push({
        file,
        kind: "gap_violation",
        reason:
          `closest daysAgo()/subDays(_, N) offset pair is (${pairA}d, ${pairB}d) — only ${gap} days apart, ` +
          `below the ≥${requiredGap}d minimum for ${bucketLabel}-level bucket assertions. ` +
          `Any fixture at ${pairA}d ago and ${pairB}d ago can land in the SAME ` +
          `calendar ${hasMonthBucket ? "month" : "week"} depending on where "today" falls ` +
          `in the ${hasMonthBucket ? "month" : "week"}, causing the bucket assertion to ` +
          `fail on a calendar schedule. ` +
          `All fixture values: [${sorted.join(", ")}]d. ` +
          `Fix: widen EVERY pair to ≥${requiredGap} days, or pin absolute timestamps. ` +
          `If the close pair is used for a non-bucket assertion and only distant ` +
          `pairs feed the bucket, add a suppression with a specific reason:\n` +
          `  // ${SUPPRESS_MARKER} <name the close pair and confirm it is NOT ` +
          `compared for month separation>\n` +
          `See .agents/memory/calendar-month-fixture-collision.md`,
      });
    }
    // All pairs gap ≥ required threshold → pass.
  }

  return { ok: offenders.length === 0, offenders, scanned: files.length };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function cliMain(): number {
  const result = runLint();
  if (result.ok) {
    console.log(
      `[${SELF}] OK — scanned ${result.scanned} test files, no calendar-fixture gap violations.`,
    );
    return 0;
  }

  console.error(
    `[${SELF}] FAILED — ${result.offenders.length} test file(s) combine NOW()-relative fixtures ` +
      `with calendar month/week bucket assertions in a way that can produce intermittent failures:`,
  );
  for (const o of result.offenders) {
    const tag =
      o.kind === "gap_violation"
        ? "GAP VIOLATION"
        : o.kind === "future_date_literal"
          ? "FUTURE DATE LITERAL"
          : "REVIEW REQUIRED";
    console.error(`\n  [${tag}] ${o.file}`);
    console.error(`    > ${o.reason}`);
  }
  console.error(
    `\nWhy this matters: a daysAgo(10)/daysAgo(40) pair lands in the same calendar month ` +
      `whenever "today" falls in the first ~10 days of a month — the suite fails on a ` +
      `calendar schedule while the green baseline (published mid-month) shows main was clean, ` +
      `causing the failure to be mis-attributed to innocent task branches.\n` +
      `See .agents/memory/calendar-month-fixture-collision.md`,
  );
  return 1;
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("lint-calendar-fixture-bucket-gap.ts");

if (isMain) {
  process.exit(cliMain());
}
