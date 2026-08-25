/* test-registration
{
  "name": "Ads OS pacing math — §6.7 schedule-aware expected/pace/recommended, pyWeekday Mon=0, month window, LSA weekly × scheduled days/wk (empty schedule → ×7), baseline daily/weekly platform budgets, resolveBudget labels (Tasks #3598, #3673, #3903)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #3598: Ads OS §6.7 pacing math — the schedule-aware expected/pace/ recommended formulas every pacing tool, dashboard pill, and the morning cron persist path depend on. Pure functions, DB-free, network-free, fast; a drift here silently mis-paces every account.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Ads OS Phase 2 — budget pacing math (spec §6.7), pure unit test.
 *
 * Guards the schedule-aware pacing formulas ported verbatim from the bundle's
 * backend/app/budget_pacing/engine.py:
 *   expected_to_date   = budget × scheduled_days_elapsed / total_scheduled_days
 *   pace %             = (mtd / expected − 1) × 100
 *   recommended_daily  = (budget − mtd) / remaining_scheduled_days
 * plus the supporting pieces the routes/dashboards depend on:
 *   - pyWeekday convention (Mon=0..Sun=6) via a real-calendar Wednesday check;
 *   - scheduledIndices: name→index mapping, empty/junk → every day;
 *   - monthWindow: [month-start, yesterday], empty on the 1st;
 *   - LSA weekly recommendation = recommended daily × scheduled days per week
 *     (empty LSA schedule → ×7, the pre-schedule behavior);
 *   - baseline platform budgets (Task #3903): GAds daily = monthly ÷ total
 *     scheduled days; LSA weekly = that × scheduled days/wk — stable on the
 *     1st (never a function of MTD spend), null without a budget;
 *   - resolveBudget source labeling (ClickUp is the sole budget authority).
 *
 * Fixed dates (July 2026: 31 days, Jul 1 = Wed, Jul 27 = Mon; weekdays 23
 * total / 18 through the 26th; Mondays 6,13,20,27). DB-free, network-free.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";

// Dynamic imports so the env pins above land BEFORE module-load-time env reads
// (db pool test-mode idle timeouts) — static imports hoist.
const {
  computePacing,
  scheduledIndices,
  monthWindow,
  resolveBudget,
  WEEKDAYS,
  inferScheduleDays,
  resolveSchedule,
  pacingDocStatus,
  INFERENCE_MIN_ACTIVE_DAYS,
  baselineDailyBudget,
} = await import("../server/services/adsOs/pacingEngine");
const { isoDate, addDays } = await import("../server/services/adsOs/dateRange");
type PlainDate = { y: number; m: number; d: number };
const { weeklyFromDaily, scheduledDaysPerWeek, baselineWeeklyBudget } =
  await import("../server/services/adsOs/lsaPacingEngine");
type SheetBudget = { gads: number; lsa: number };

// ── (a) Every-day schedule (LSA semantics: schedule [] → all days) ──────────
{
  // today = 2026-07-27 → window counts days 1..26 of a 31-day month.
  const m = computePacing(3100, 2400, [], { y: 2026, m: 7, d: 27 });
  assert.equal(m.days_in_month, 31, "July has 31 days");
  assert.equal(m.total_scheduled_days, 31, "empty schedule = every day");
  assert.equal(m.scheduled_days_elapsed, 26, "elapsed through yesterday (26th)");
  assert.equal(m.expected_to_date, 2600, "expected = 3100 × 26/31 = 2600");
  assert.equal(m.on_off_track_pct, -7.7, "pace = (2400/2600 − 1)×100 → −7.7 (round1)");
  assert.equal(m.recommended_daily_budget, 140, "recommended = (3100−2400)/5 remaining");
  assert.equal(m.avg_daily_spend_mtd, 92.31, "avg = 2400/26 → 92.31 (round2)");
  console.log("  ✓ every-day schedule: expected/pace/recommended/avg (July 2026)");
}

// ── (b) Custom Mon–Fri schedule ──────────────────────────────────────────────
{
  const monFri = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const m = computePacing(2300, 2000, monFri, { y: 2026, m: 7, d: 27 });
  assert.equal(m.total_scheduled_days, 23, "July 2026 has 23 weekdays");
  assert.equal(m.scheduled_days_elapsed, 18, "18 weekdays through the 26th");
  assert.equal(m.expected_to_date, 1800, "expected = 2300 × 18/23 = 1800");
  assert.equal(m.on_off_track_pct, 11.1, "pace = (2000/1800 − 1)×100 → 11.1");
  assert.equal(m.recommended_daily_budget, 60, "recommended = 300 / 5 remaining weekdays");
  assert.equal(m.avg_daily_spend_mtd, 111.11, "avg over SCHEDULED elapsed days only");
  console.log("  ✓ Mon–Fri schedule: scheduled-day counting drives all four outputs");
}

// ── (c) pyWeekday convention: Jul 1 2026 is a Wednesday ─────────────────────
{
  // Wed-only schedule, today = Jul 2 → exactly one scheduled day elapsed
  // (the 1st), five Wednesdays in the month (1,8,15,22,29). If the Mon=0
  // mapping drifted (e.g. JS Sun=0 used directly), these counts break.
  const m = computePacing(500, 100, ["Wed"], { y: 2026, m: 7, d: 2 });
  assert.equal(m.total_scheduled_days, 5, "five Wednesdays in July 2026");
  assert.equal(m.scheduled_days_elapsed, 1, "Jul 1 2026 IS a Wednesday");
  assert.deepEqual([...scheduledIndices(["Mon", "Wed"])].sort(), [0, 2], "Mon=0, Wed=2");
  assert.equal(WEEKDAYS[0], "Mon", "WEEKDAYS starts Monday (python convention)");
  console.log("  ✓ pyWeekday: Mon=0 convention verified against the real calendar");
}

// ── (d) Edges: 1st of month, no budget, remaining=0, junk schedule ──────────
{
  // 1st of the month: nothing elapsed → expected 0, pct null (no division),
  // recommended = full budget over all scheduled days.
  const first = computePacing(3100, 0, [], { y: 2026, m: 7, d: 1 });
  assert.equal(first.scheduled_days_elapsed, 0, "nothing elapsed on the 1st");
  assert.equal(first.expected_to_date, 0, "expected 0 on the 1st");
  assert.equal(first.on_off_track_pct, null, "pace null when expected = 0");
  assert.equal(first.recommended_daily_budget, 100, "recommended = 3100/31 on the 1st");

  // No budget: all budget-derived outputs null, avg still computed.
  const noBudget = computePacing(null, 1300, [], { y: 2026, m: 7, d: 27 });
  assert.equal(noBudget.expected_to_date, null, "no budget → expected null");
  assert.equal(noBudget.on_off_track_pct, null, "no budget → pace null");
  assert.equal(noBudget.recommended_daily_budget, null, "no budget → recommended null");
  assert.equal(noBudget.avg_daily_spend_mtd, 50, "avg spend still reported (1300/26)");

  // Mondays-only, today Jul 28 → all 4 Mondays (6,13,20,27) elapsed,
  // 0 remaining → recommended null (no divide-by-zero).
  const spent = computePacing(400, 380, ["Mon"], { y: 2026, m: 7, d: 28 });
  assert.equal(spent.total_scheduled_days, 4, "four Mondays in July 2026");
  assert.equal(spent.scheduled_days_elapsed, 4, "all Mondays elapsed by the 28th");
  assert.equal(spent.recommended_daily_budget, null, "0 scheduled days left → null");

  // Mondays-only, today Jul 27 → 3 elapsed, 1 remaining → whole gap lands on it.
  const lastDay = computePacing(400, 250, ["Mon"], { y: 2026, m: 7, d: 27 });
  assert.equal(lastDay.scheduled_days_elapsed, 3, "Mondays 6/13/20 elapsed by the 27th");
  assert.equal(lastDay.recommended_daily_budget, 150, "(400−250)/1 remaining Monday");

  // Junk/empty schedule names fall back to every-day (never a 0-day schedule).
  assert.equal(scheduledIndices(["Funday"]).size, 7, "unknown names → every day");
  assert.equal(scheduledIndices([]).size, 7, "empty schedule → every day");

  // Leap February: 2028-02-29 exists.
  const leap = computePacing(2900, 0, [], { y: 2028, m: 2, d: 29 });
  assert.equal(leap.days_in_month, 29, "Feb 2028 has 29 days");
  assert.equal(leap.scheduled_days_elapsed, 28, "28 days elapsed on the 29th");
  console.log("  ✓ edges: 1st-of-month, null budget, exhausted schedule, junk names, leap Feb");
}

// ── (e) monthWindow: [month-start, yesterday]; empty on the 1st ─────────────
{
  const mid = monthWindow({ y: 2026, m: 7, d: 15 });
  assert.deepEqual(mid.monthStart, { y: 2026, m: 7, d: 1 }, "window starts on the 1st");
  assert.deepEqual(mid.endDate, { y: 2026, m: 7, d: 14 }, "window ends yesterday");
  const first = monthWindow({ y: 2026, m: 7, d: 1 });
  assert.deepEqual(first.endDate, { y: 2026, m: 6, d: 30 }, "on the 1st the window is empty (end < start)");
  console.log("  ✓ monthWindow: 1st → yesterday, empty on the 1st");
}

// ── (f) LSA weekly recommendation = daily × scheduled days per week ─────────
{
  // Back-compat: no daysPerWeek argument → ×7, exactly the pre-schedule math.
  assert.equal(weeklyFromDaily(60), 420, "weekly = daily × 7 by default");
  assert.equal(weeklyFromDaily(142.86), 1000.02, "rounded to cents after ×7");
  assert.equal(weeklyFromDaily(null), null, "null daily → null weekly");

  // Schedule-aware: a Mon–Fri client's weekly recommendation covers 5 serving
  // days; empty/junk LSA schedules fall back to 7 so existing clients (no LSA
  // schedule saved) keep today's ×7 numbers.
  assert.equal(scheduledDaysPerWeek(["Mon", "Tue", "Wed", "Thu", "Fri"]), 5, "Mon–Fri → 5 days/wk");
  assert.equal(scheduledDaysPerWeek([]), 7, "empty LSA schedule → 7 (every day)");
  assert.equal(scheduledDaysPerWeek(["Funday"]), 7, "junk names → every day");
  assert.equal(scheduledDaysPerWeek(["Mon", "mon", " MON "]), 1, "dedup + case/space-insensitive");
  assert.equal(weeklyFromDaily(60, 5), 300, "Mon–Fri: weekly = daily × 5 serving days");
  assert.equal(
    weeklyFromDaily(60, scheduledDaysPerWeek([])),
    420,
    "empty schedule via scheduledDaysPerWeek → ×7 (back-compat path the engine uses)",
  );
  assert.equal(weeklyFromDaily(null, 5), null, "null daily stays null under a schedule");
  console.log("  ✓ LSA weekly recommendation = daily × scheduled days/wk (×7 with no schedule)");
}

// ── (l) Baseline platform budgets: monthly budget + schedule ONLY (Task #3903)
// GAds baseline daily = monthly ÷ total scheduled days; LSA baseline weekly =
// that × scheduled serving days per week. Unlike the corrective recommended
// figures these never read MTD spend, so they're identical on the 1st (zero
// scheduled days elapsed, pacing "Not started") and mid-month.
{
  // Screenshot fixture: Mon–Sat August 2026 (Aug 1 = Sat; Sundays 2,9,16,23,30)
  // → 26 scheduled days; $1,500 ÷ 26 = 57.69 (displays as the $58 tile).
  const monSat = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mid = computePacing(1500, 200, monSat, { y: 2026, m: 8, d: 6 });
  assert.equal(mid.total_scheduled_days, 26, "Aug 2026 minus 5 Sundays = 26 scheduled days");
  assert.equal(mid.scheduled_days_elapsed, 4, "1,3,4,5 Aug elapsed by the 6th (screenshot's 4/26)");
  assert.equal(baselineDailyBudget(1500, mid.total_scheduled_days), 57.69, "1500 ÷ 26 → 57.69");

  // 1st of the month: zero scheduled days elapsed, pacing neutral — baseline
  // unchanged (it never depends on MTD spend or elapsed days).
  const first = computePacing(1500, 0, monSat, { y: 2026, m: 8, d: 1 });
  assert.equal(first.scheduled_days_elapsed, 0, "nothing elapsed on the 1st");
  assert.equal(first.on_off_track_pct, null, "pacing itself is neutral on the 1st");
  assert.equal(
    baselineDailyBudget(1500, first.total_scheduled_days),
    57.69,
    "same baseline on the 1st as mid-month",
  );

  // Every-day default: monthly ÷ days in month.
  const everyDay = computePacing(3100, 999, [], { y: 2026, m: 7, d: 27 });
  assert.equal(baselineDailyBudget(3100, everyDay.total_scheduled_days), 100, "3100 ÷ 31 days");

  // No budget / no scheduled days → null, never a fake $0.
  assert.equal(baselineDailyBudget(null, 26), null, "no budget → null");
  assert.equal(baselineDailyBudget(1500, 0), null, "no scheduled days → null");

  // LSA weekly = (monthly ÷ total scheduled days) × scheduled days/wk, through
  // the same weeklyFromDaily/scheduledDaysPerWeek semantics as the corrective
  // recommendation: every-day → ×7, Mon–Fri → ×5, null budget stays null.
  assert.equal(
    baselineWeeklyBudget(3100, 31, scheduledDaysPerWeek([])),
    700,
    "every-day: (3100/31) × 7 = 700",
  );
  assert.equal(
    baselineWeeklyBudget(2300, 23, scheduledDaysPerWeek(["Mon", "Tue", "Wed", "Thu", "Fri"])),
    500,
    "Mon–Fri July 2026: (2300/23) × 5 = 500",
  );
  assert.equal(baselineWeeklyBudget(null, 31, 7), null, "no budget → null weekly");
  assert.equal(baselineWeeklyBudget(1500, 0, 7), null, "no scheduled days → null weekly");
  // Rounding pipeline mirrors weeklyFromDaily: daily is rounded to cents FIRST
  // (1000/31 → 32.26), then × 7 → 225.82 (not 225.81 from the raw product).
  assert.equal(baselineWeeklyBudget(1000, 31, 7), 225.82, "round2 daily then × days/wk");
  console.log("  ✓ baselines: monthly÷scheduled days (GAds) ×days/wk (LSA), stable on the 1st, null without budget");
}

// ── (h) Weekday-only account across a month-opening weekend (Task #3706) ────
// THE bug: Aug 1–2 2026 is Sat–Sun. Under the every-day default those count as
// 2 elapsed days with $0 spend → −100% "far behind". Under the real Mon–Fri
// schedule ZERO scheduled days have elapsed → pct must be null (neutral),
// never −100.
{
  const monFri = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const m = computePacing(2100, 0, monFri, { y: 2026, m: 8, d: 3 });
  assert.equal(m.scheduled_days_elapsed, 0, "Aug 1–2 2026 are weekend days — none elapsed");
  assert.equal(m.total_scheduled_days, 21, "Aug 2026 has 21 weekdays");
  assert.equal(m.expected_to_date, 0, "nothing expected before the first scheduled day");
  assert.equal(m.on_off_track_pct, null, "pct NULL (neutral), never −100");
  assert.equal(m.recommended_daily_budget, 100, "recommended = 2100/21 — full month ahead");

  // Contrast: the every-day default on the same date DOES read −100 with $0
  // spend — this is exactly why the schedule must be resolved, not assumed.
  const everyDay = computePacing(2100, 0, [], { y: 2026, m: 8, d: 3 });
  assert.equal(everyDay.scheduled_days_elapsed, 2, "every-day counts the weekend");
  assert.equal(everyDay.on_off_track_pct, -100, "…and $0 over it reads −100 (the bug)");
  console.log("  ✓ weekday-only account: opening weekend → pct null, not −100 (Task #3706)");
}

// ── (i) inferScheduleDays: serving days from actual daily spend ─────────────
{
  // 28-day window Mon Jul 6 → Sun Aug 2 2026 (exactly what runBudgetPacing
  // passes on Aug 3). Helper builds a daily map from a per-weekday spender.
  const winStart: PlainDate = { y: 2026, m: 7, d: 6 };
  const winEnd: PlainDate = { y: 2026, m: 8, d: 2 };
  const buildDaily = (spendOn: (wd: number, iso: string) => number): Map<string, number> => {
    const daily = new Map<string, number>();
    for (let day = winStart; isoDate(day) <= isoDate(winEnd); day = addDays(day, 1)) {
      // pyWeekday convention: Mon Jul 6 is wd 0; day-of-week cycles from there.
      const wd = (Math.round((Date.UTC(day.y, day.m - 1, day.d) - Date.UTC(2026, 6, 6)) / 86400000) % 7 + 7) % 7;
      const v = spendOn(wd, isoDate(day));
      if (v > 0) daily.set(isoDate(day), v);
    }
    return daily;
  };

  // Clean Mon–Fri pattern → inferred weekdays.
  const monFri = inferScheduleDays(buildDaily((wd) => (wd <= 4 ? 50 : 0)), winStart, winEnd);
  assert.deepEqual(monFri, { days: ["Mon", "Tue", "Wed", "Thu", "Fri"], source: "inferred" });

  // One skipped Friday (holiday) — 3 of 4 Fridays spent = 75% ≥ 50% → still on.
  const holiday = inferScheduleDays(
    buildDaily((wd, iso) => (wd <= 4 && iso !== "2026-07-17" ? 50 : 0)),
    winStart, winEnd,
  );
  assert.deepEqual(holiday.days, ["Mon", "Tue", "Wed", "Thu", "Fri"], "one holiday doesn't drop the day");

  // No spend at all → default every-day (nothing to infer from).
  assert.deepEqual(inferScheduleDays(new Map(), winStart, winEnd), { days: [], source: "default" });

  // Short history: first spend Sat Jul 25 → only 9 observed days (< min 14) →
  // default, so a brand-new account isn't typecast off its launch week.
  const short = inferScheduleDays(
    buildDaily((_wd, iso) => (iso >= "2026-07-25" ? 40 : 0)),
    winStart, winEnd,
  );
  assert.ok(9 < INFERENCE_MIN_ACTIVE_DAYS, "sanity: 9 observed < min");
  assert.deepEqual(short, { days: [], source: "default" });

  // Spend every single day → inferred every-day, canonical EMPTY list (so
  // downstream schedule handling stays on the one "no restriction" shape).
  const all7 = inferScheduleDays(buildDaily(() => 25), winStart, winEnd);
  assert.deepEqual(all7, { days: [], source: "inferred" });

  // Sub-cent noise doesn't count as "spent": weekend $0.005 stays OFF.
  const noise = inferScheduleDays(
    buildDaily((wd) => (wd <= 4 ? 50 : 0.005)),
    winStart, winEnd,
  );
  assert.deepEqual(noise.days, ["Mon", "Tue", "Wed", "Thu", "Fri"], "sub-cent weekend ≠ serving day");

  // Sparse spend that clears the min-history bar but no weekday hits 50% of
  // its occurrences → default (never an empty "no days" schedule).
  const sparse = inferScheduleDays(
    buildDaily((_wd, iso) => (iso === "2026-07-06" || iso === "2026-07-22" ? 30 : 0)),
    winStart, winEnd,
  );
  assert.deepEqual(sparse, { days: [], source: "default" });
  console.log("  ✓ inferScheduleDays: Mon–Fri pattern, holiday tolerance, no-spend/short/sparse → default");
}

// ── (j) resolveSchedule: saved criteria always win ───────────────────────────
{
  const winStart: PlainDate = { y: 2026, m: 7, d: 6 };
  const winEnd: PlainDate = { y: 2026, m: 8, d: 2 };
  // A saved Wed-only schedule beats a daily map that screams Mon–Fri.
  const daily = new Map<string, number>();
  for (let day = winStart; isoDate(day) <= isoDate(winEnd); day = addDays(day, 1)) daily.set(isoDate(day), 50);
  assert.deepEqual(
    resolveSchedule(["Wed"], daily, winStart, winEnd),
    { days: ["Wed"], source: "saved" },
    "saved wins over inference",
  );
  assert.equal(
    resolveSchedule([], daily, winStart, winEnd).source,
    "inferred",
    "no saved schedule → inference runs",
  );
  console.log("  ✓ resolveSchedule: saved criteria beat inference; empty saved → infer");
}

// ── (k) pacingDocStatus: dashboard status incl. neutral not_started ─────────
{
  assert.equal(pacingDocStatus({ monthly_budget: 100, mtd_spend: 100, budget_pacing_pct: 0 }), "mbh");
  assert.equal(pacingDocStatus({ monthly_budget: 100, mtd_spend: 50, budget_pacing_pct: 10 }), "overspend");
  assert.equal(pacingDocStatus({ monthly_budget: 100, mtd_spend: 50, budget_pacing_pct: 0 }), "on_track");
  assert.equal(pacingDocStatus({ monthly_budget: 100, mtd_spend: 50, budget_pacing_pct: -5 }), "on_track");
  assert.equal(pacingDocStatus({ monthly_budget: 100, mtd_spend: 50, budget_pacing_pct: -5.1 }), "underspend");
  // Neutral not_started: budget present + pct null + doc SAYS 0 scheduled days
  // elapsed (the Aug-1-weekend state persisted by the morning refresh).
  assert.equal(
    pacingDocStatus({ monthly_budget: 500, mtd_spend: 0, budget_pacing_pct: null, scheduled_days_elapsed: 0 }),
    "not_started",
  );
  // Older docs (no elapsed field), missing budget, or empty docs stay unknown —
  // "not_started" must never mask a genuinely unknown/failed state.
  assert.equal(pacingDocStatus({ monthly_budget: 500, budget_pacing_pct: null }), "unknown");
  assert.equal(pacingDocStatus({ budget_pacing_pct: null, scheduled_days_elapsed: 0 }), "unknown");
  assert.equal(pacingDocStatus({}), "unknown");
  console.log("  ✓ pacingDocStatus: mbh/over/on/under thresholds + not_started vs unknown split");
}

// ── (g) resolveBudget source labeling ────────────────────────────────────────
{
  const budgets = new Map<string, SheetBudget>([
    ["1111111111", { gads: 1500, lsa: 0 }],
    ["2222222222", { gads: 0, lsa: 900 }],
  ]);
  // Positive budgets are always labeled ClickUp.
  assert.deepEqual(
    resolveBudget(budgets, "1111111111"),
    { budget: 1500, source: "clickup" },
    "gads budget resolves with the clickup label under auto",
  );
  assert.deepEqual(
    resolveBudget(budgets, "2222222222"),
    { budget: null, source: "none" },
    "LSA-only account has no GAds budget",
  );
  assert.deepEqual(
    resolveBudget(budgets, "9999999999"),
    { budget: null, source: "none" },
    "unknown CID → none",
  );
  console.log("  ✓ resolveBudget: gads>0 wins, LSA-only/unknown → none");
}

console.log("ads-os-pacing-math: all sections passed (Task #3598).");
