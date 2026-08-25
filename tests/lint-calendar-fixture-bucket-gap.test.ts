/* test-registration
{
  "name": "Calendar-fixture bucket-gap lint (Task #4207)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Fast (~0.1s, DB-free, deterministic) text scan over test fixtures; guards the gate against calendar-schedule regressions from NOW()-relative fixture pairs feeding month/week bucket assertions. Core lint-* always-run rule.",
  "tier": "small"
}
test-registration */
/**
 * Task #4207 — Regression test for the calendar-fixture bucket-gap lint.
 *
 * Proves:
 *   1. A file with daysAgo(10)+daysAgo(40) (spread 30d < 60d) AND a YYYY-MM
 *      bucket assertion is flagged as a gap violation.
 *   2. A file with daysAgo(10)+daysAgo(70) (spread 60d ≥ 60d) AND YYYY-MM
 *      bucket assertion passes (every pair is ≥60d apart).
 *   3. An unrelated distant fixture (daysAgo 70) cannot launder a close pair
 *      (daysAgo 10 + daysAgo 15) — the close pair is still flagged. This
 *      exercises the min-pairwise-gap model: spread = 60 would pass the naive
 *      max-spread check, but min gap = 5d < 60d → FAIL.
 *   4. A file with make_interval() seeding AND YYYY-MM bucket is flagged for
 *      review (non-extractable gap).
 *   5. A file with seeding but NO bucket assertion passes.
 *   6. A file with a bucket assertion but NO seeding passes.
 *   7. A file with a single daysAgo(N) and a bucket assertion passes (no pair
 *      to collide).
 *   8. A file suppressed by the review marker passes regardless of gap —
 *      but ONLY that file; a separate file with the same close-pair pattern
 *      and no marker is still caught (markers cannot blanket-suppress new
 *      violations in other files).
 *   9. The real tests/ tree is clean (no unreviewed violations).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLint } from "../scripts/lint-calendar-fixture-bucket-gap";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lint-cal-fixture-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// 1. Gap violation: daysAgo(10) + daysAgo(40) + YYYY-MM → flagged (gap 30 < 60).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "offender.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "assert(res.r1Month !== res.r2Month, 'fixtures in different months');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "daysAgo 10/40 (gap 30d) with YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "gap_violation"),
      "offender is classified as gap_violation",
    );
  } finally {
    cleanup();
  }
}

// 2. Safe gap: daysAgo(10) + daysAgo(70) + YYYY-MM → passes (every pair ≥60d).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "safe.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(70) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "assert(res.r1Month !== res.r2Month, 'fixtures in different months');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "daysAgo 10/70 (gap 60d) with YYYY-MM passes");
    assert(res.offenders.length === 0, "no offenders reported");
  } finally {
    cleanup();
  }
}

// 3. BYPASS REGRESSION: unrelated distant fixture cannot launder a close pair.
//    File has daysAgo(10), daysAgo(15) (close — gap 5d), and daysAgo(70)
//    (unrelated/distant). Max-spread = 60d would pass a naive check, but the
//    close pair (10, 15) is still a calendar-schedule hazard and MUST be flagged.
//    This exercises the min-pairwise-gap model vs the discredited max-spread model.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "laundering-attempt.test.ts"),
      [
        "// Three fixtures: two close (10d, 15d for same-month control) and one distant",
        "// (70d for month-separation). A naive max-spread check would pass (70-10=60),",
        "// but the close pair (10d, 15d) is still a risk if ever compared in a month",
        "// bucket assertion.",
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(70) });",
        "const r3 = await seed({ timestamp: daysAgo(15) });  // same-month control",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "assert(res.r2Month !== res.r1Month, 'month filter separates r1 and r2');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "close pair (10d, 15d) is flagged even though a distant 70d fixture exists",
    );
    assert(
      res.offenders.some((o) => o.kind === "gap_violation"),
      "offender classified as gap_violation (min-pairwise-gap model, not max-spread)",
    );
  } finally {
    cleanup();
  }
}

// 4. make_interval co-occurrence → review_required.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "make_interval.test.ts"),
      [
        "const r1 = await seed({ ts: sql`NOW() - make_interval(days => 10)` });",
        "const r2 = await seed({ ts: sql`NOW() - make_interval(days => 70)` });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "make_interval + YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      "offender is classified as review_required",
    );
  } finally {
    cleanup();
  }
}

// 5. Seeding with NO bucket assertion → passes.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "no-bucket.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(40) });",
        "assert(r1.id !== r2.id, 'distinct rows');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "seeding without a calendar bucket assertion is not flagged",
    );
  } finally {
    cleanup();
  }
}

// 6. Bucket assertion with NO seeding → passes.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "no-seeding.test.ts"),
      [
        "// Uses pinned absolute dates — no NOW()-relative seeding.",
        "const rows = await query(`SELECT to_char(ts, 'YYYY-MM') AS m WHERE ts > '2026-01-01'`);",
        "assert(rows[0].m === '2026-01', 'pinned month matches');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "bucket assertion without NOW()-relative seeding is not flagged",
    );
  } finally {
    cleanup();
  }
}

// 7. Single daysAgo value + bucket → passes (no pair to collide).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "single-fixture.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(15) });",
        "const month = await query(`SELECT to_char(ts, 'YYYY-MM') AS m FROM t WHERE id = ${r1}`);",
        "assert(month === expectedMonth, 'correct month');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "single daysAgo fixture with bucket assertion passes (no collision pair)",
    );
  } finally {
    cleanup();
  }
}

// 8a. Suppressed by review marker → passes for THAT file.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "suppressed.test.ts"),
      [
        "// calendar-fixture-gap-reviewed: r3(15d) is a same-month control for r1(10d);",
        "// only the r1(10d)/r2(70d) pair feeds the YYYY-MM month-separation assertion",
        "// and that pair has a 60d gap safe on any calendar date.",
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(70) });",
        "const r3 = await seed({ timestamp: daysAgo(15) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "file with review marker is suppressed");
    assert(res.offenders.length === 0, "no offenders reported for suppressed file");
  } finally {
    cleanup();
  }
}

// 8b. Marker in file A does NOT suppress a violation in file B (markers are
//     file-scoped; they cannot blanket-suppress new violations elsewhere).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "file-a-suppressed.test.ts"),
      [
        "// calendar-fixture-gap-reviewed: only the 10d/70d pair feeds the month assertion.",
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(70) });",
        "const r3 = await seed({ timestamp: daysAgo(15) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "file-b-unrelated.test.ts"),
      [
        "// No marker — different file, different close pair.",
        "const x = await seed({ timestamp: daysAgo(5) });",
        "const y = await seed({ timestamp: daysAgo(20) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "marker in file A does not suppress a close-pair violation in file B",
    );
    assert(
      res.offenders.some((o) => o.file.endsWith("file-b-unrelated.test.ts")),
      "file B is independently flagged despite file A's marker",
    );
    assert(
      res.offenders.every((o) => !o.file.endsWith("file-a-suppressed.test.ts")),
      "file A itself is still suppressed by its own marker",
    );
  } finally {
    cleanup();
  }
}

// 9a. Empty marker (no reason after colon) → NOT suppressed, still flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "empty-marker.test.ts"),
      [
        "// calendar-fixture-gap-reviewed:",
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "empty marker (no reason after colon) does not suppress the violation",
    );
    assert(
      res.offenders.some((o) => o.file.endsWith("empty-marker.test.ts")),
      "empty-marker file is still flagged",
    );
  } finally {
    cleanup();
  }
}

// 9b. Marker embedded in a string literal → NOT suppressed, still flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "string-marker.test.ts"),
      [
        'const note = "calendar-fixture-gap-reviewed: r1(10d) and r2(40d) confirmed safe";',
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "marker in a string literal does not count as a valid suppression",
    );
    assert(
      res.offenders.some((o) => o.file.endsWith("string-marker.test.ts")),
      "string-embedded marker file is still flagged",
    );
  } finally {
    cleanup();
  }
}

// 9c. Marker in a block comment → NOT suppressed (only // line comments accepted).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "block-comment-marker.test.ts"),
      [
        "/* calendar-fixture-gap-reviewed: r1(10d) and r2(40d) confirmed safe */",
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "marker in a block comment does not count as a valid suppression",
    );
    assert(
      res.offenders.some((o) => o.file.endsWith("block-comment-marker.test.ts")),
      "block-comment marker file is still flagged",
    );
  } finally {
    cleanup();
  }
}

// 10. WEEK BUCKET (Task #4247): daysAgo(1) + daysAgo(6) + date_trunc('week')
//     → flagged. The pair shares an ISO week whenever "today" is Mon–Sat,
//     failing on a WEEKLY schedule. Week threshold is ≥14d.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "week-offender.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(1) });",
        "const r2 = await seed({ timestamp: daysAgo(6) });",
        "const res = await query(`SELECT date_trunc('week', ts) AS week_start`);",
        "assert(res.r1Week !== res.r2Week, 'fixtures in different weeks');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "daysAgo 1/6 (gap 5d) with date_trunc('week') is flagged");
    assert(
      res.offenders.some(
        (o) => o.kind === "gap_violation" && /week/.test(o.reason),
      ),
      "week-bucket offender is a gap_violation naming the week threshold",
    );
  } finally {
    cleanup();
  }
}

// 11. WEEK BUCKET safe gap: daysAgo(1) + daysAgo(14) + week bucket → passes
//     (≥14d gap guarantees different ISO weeks on any calendar date).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "week-safe.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(1) });",
        "const r2 = await seed({ timestamp: daysAgo(14) });",
        "const res = await query(`SELECT date_trunc('week', ts) AS week_start`);",
        "assert(res.r1Week !== res.r2Week, 'fixtures in different weeks');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "daysAgo 1/14 (13d gap, 14-day span) with week bucket passes");
    assert(res.offenders.length === 0, "no offenders for the safe week pair");
  } finally {
    cleanup();
  }
}

// 12. MIXED buckets: week AND month buckets present → the stricter 60d month
//     threshold applies; a 20d gap (safe for week-only) is still flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "mixed-bucket.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: daysAgo(30) });",
        "const w = await query(`SELECT date_trunc('week', ts) AS week_start`);",
        "const m = await query(`SELECT to_char(ts, 'YYYY-MM') AS month`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "20d gap with BOTH week and month buckets is flagged (month 60d threshold wins)",
    );
  } finally {
    cleanup();
  }
}

// 11a. (Task #4248) subDays second-arg extraction: subDays(now, 10) + subDays(now, 40)
//      + YYYY-MM → gap_violation (gap 30 < 60).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "subdays-offender.test.ts"),
      [
        "const r1 = await seed({ timestamp: subDays(now, 10) });",
        "const r2 = await seed({ timestamp: subDays(now, 40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "assert(res.r1Month !== res.r2Month, 'fixtures in different months');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "subDays(now, 10)/subDays(now, 40) with YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "gap_violation"),
      "subDays offender is classified as gap_violation (2nd-arg extraction)",
    );
  } finally {
    cleanup();
  }
}

// 11b. (Task #4248) subDays safe gap: subDays(now, 10) + subDays(now, 70) → passes.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "subdays-safe.test.ts"),
      [
        "const r1 = await seed({ timestamp: subDays(new Date(), 10) });",
        "const r2 = await seed({ timestamp: subDays(new Date(), 70) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(res.ok, "subDays 10/70 (gap 60d, new Date() first arg) passes");
  } finally {
    cleanup();
  }
}

// 11c. (Task #4248) mixed extraction: daysAgo(10) + subDays(now, 15) → close pair flagged.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "mixed-offender.test.ts"),
      [
        "const r1 = await seed({ timestamp: daysAgo(10) });",
        "const r2 = await seed({ timestamp: subDays(now, 15) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "mixed daysAgo(10)/subDays(now, 15) close pair is flagged");
    assert(
      res.offenders.some((o) => o.kind === "gap_violation"),
      "mixed-extractor offender is classified as gap_violation",
    );
  } finally {
    cleanup();
  }
}

// 11d. (Task #4248) setDate seeding → review_required (non-extractable).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "setdate-review.test.ts"),
      [
        "const d1 = new Date(); d1.setDate(d1.getDate() - 10);",
        "const d2 = new Date(); d2.setDate(d2.getDate() - 40);",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, ".setDate() seeding with YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      ".setDate() offender is classified as review_required (non-extractable)",
    );
  } finally {
    cleanup();
  }
}

// 11e. (Task #4248) hoursAgo/monthsAgo/setMonth seeding → review_required.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "hoursago-review.test.ts"),
      [
        "const r1 = await seed({ timestamp: hoursAgo(240) });",
        "const r2 = await seed({ timestamp: monthsAgo(2) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "hoursAgo()/monthsAgo() seeding with YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      "hoursAgo/monthsAgo offender is classified as review_required",
    );
  } finally {
    cleanup();
  }
}

// 11f. (Task #4248) BYPASS REGRESSION: subDays with a nested comma-bearing first
//      argument is NOT statically extractable — it must route to review_required,
//      never pass silently (two close fixtures would otherwise slip through).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "subdays-nested-comma.test.ts"),
      [
        "const r1 = await seed({ timestamp: subDays(startOfWeek(now, { weekStartsOn: 1 }), 10) });",
        "const r2 = await seed({ timestamp: subDays(startOfWeek(now, { weekStartsOn: 1 }), 40) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      !res.ok,
      "subDays with nested comma-bearing first arg does not pass silently",
    );
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      "nested-comma subDays offender is classified as review_required",
    );
  } finally {
    cleanup();
  }
}

// 11g. (Task #4248) subDays with a non-literal second argument → review_required.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "subdays-nonliteral.test.ts"),
      [
        "const r1 = await seed({ timestamp: subDays(now, offsetA) });",
        "const r2 = await seed({ timestamp: subDays(now, offsetB) });",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "subDays with non-literal offsets is flagged");
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      "non-literal subDays offender is classified as review_required",
    );
  } finally {
    cleanup();
  }
}

// 11h. (Task #4248) explicit .setMonth() fixture → review_required.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "setmonth-review.test.ts"),
      [
        "const d1 = new Date(); d1.setMonth(d1.getMonth() - 1);",
        "const d2 = new Date(); d2.setMonth(d2.getMonth() - 3);",
        "const res = await query(`SELECT to_char(ts, 'YYYY-MM') AS m`);",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, ".setMonth() seeding with YYYY-MM is flagged");
    assert(
      res.offenders.some((o) => o.kind === "review_required"),
      ".setMonth() offender is classified as review_required",
    );
  } finally {
    cleanup();
  }
}

// ── Task #4433: absolute future-date literal check ──────────────────────
// Fixture dates are computed at test runtime so this guard itself never rots.
const iso = (daysOut: number) =>
  new Date(Date.now() + daysOut * 86_400_000).toISOString().slice(0, 10);

// 13a. Near-future quoted literal → flagged as future_date_literal.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "future-literal-offender.test.ts"),
      [
        `const play = await createPlay({ dueDate: "${iso(30)}" });`,
        "assert(play.overdue === false, 'future-due play is not overdue');",
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(!res.ok, "a quoted literal ~30 days in the future is flagged");
    assert(
      res.offenders.some((o) => o.kind === "future_date_literal"),
      "offender is classified as future_date_literal",
    );
  } finally {
    cleanup();
  }
}

// 13b. Past literal and far-future sentinel (beyond the 3-year horizon) pass.
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "future-literal-safe.test.ts"),
      [
        `const old = await seed({ judgmentDate: "${iso(-30)}" });`,
        'const sentinel = { cursorTs: "2099-01-01T00:00:00.000Z" };',
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "past literals and far-future (>3y) sentinels are not flagged",
    );
  } finally {
    cleanup();
  }
}

// 13c. Valid future-date-literal-reviewed marker suppresses; the gap marker
//      does NOT (separate concerns, separate markers).
{
  const { root, cleanup } = fixture();
  try {
    writeFileSync(
      join(root, "future-literal-marked.test.ts"),
      [
        `// future-date-literal-reviewed: ${iso(30)} is compared only against a pinned injected clock.`,
        `const play = await createPlay({ dueDate: "${iso(30)}" });`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "future-literal-wrong-marker.test.ts"),
      [
        "// calendar-fixture-gap-reviewed: reviewed for the gap rule only.",
        `const play = await createPlay({ dueDate: "${iso(30)}" });`,
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.offenders.every((o) => !o.file.endsWith("future-literal-marked.test.ts")),
      "future-date-literal-reviewed marker suppresses the check for its file",
    );
    assert(
      res.offenders.some(
        (o) =>
          o.kind === "future_date_literal" &&
          o.file.endsWith("future-literal-wrong-marker.test.ts"),
      ),
      "the gap-rule marker does NOT suppress the future-date-literal check",
    );
  } finally {
    cleanup();
  }
}

// 13d. Literal inside a comment does not trip (stripped before scanning), and
//      an invalid rolled-over date like -13-40 is ignored.
{
  const { root, cleanup } = fixture();
  try {
    const y = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 4);
    writeFileSync(
      join(root, "future-literal-comments.test.ts"),
      [
        `// example bomb: dueDate: "${iso(30)}" — commented, must not trip`,
        `const notADate = "${y}-13-40";`,
        "",
      ].join("\n"),
    );
    const res = runLint(root);
    assert(
      res.ok,
      "commented-out literals and non-parsing dates are not flagged",
    );
  } finally {
    cleanup();
  }
}

// Final. Real tests/ tree is clean.
{
  const res = runLint("tests");
  if (!res.ok) {
    for (const o of res.offenders) {
      console.error(`    [${o.kind}] ${o.file}`);
      console.error(`      > ${o.reason}`);
    }
  }
  assert(
    res.ok,
    "tests/ tree: no calendar-fixture gap violations or unreviewed co-occurrences",
  );
}

console.log(`\n  passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
