/* test-registration
{
  "name": "Zoom RRULE translator (Task #1032C)",
  "tier": "small"
}
test-registration */
/**
 * Task #1032C — Zoom RRULE translator unit tests.
 *
 * Pure helper behavior — no DB, no HTTP. Verifies every "must support
 * when representable" pattern from the epic plus the structured fallback
 * reasons for non-representable cases.
 */

import {
  translateRRuleToZoomRecurrence,
} from "../server/services/zoomIntegration";
import type {
  ZoomRecurrenceObject,
  ZoomRecurrenceFallbackReason,
} from "@shared/schema";

let failed = 0;
let passed = 0;

function assert(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string): void {
  console.log(`\n— ${title} —`);
}

function representable(rrule: string, exdates?: Date[]): ZoomRecurrenceObject {
  const r = translateRRuleToZoomRecurrence({
    rrule,
    exdates,
    timezone: "America/Chicago",
  });
  if (!r.fullyRepresentable) {
    throw new Error(
      `Expected fullyRepresentable for ${rrule}, got reason=${r.reason}: ${r.message}`,
    );
  }
  return r.zoomRecurrence;
}

function fallbackReason(
  rrule: string,
  exdates?: Date[],
): ZoomRecurrenceFallbackReason {
  const r = translateRRuleToZoomRecurrence({
    rrule,
    exdates,
    timezone: "America/Chicago",
  });
  if (r.fullyRepresentable) {
    throw new Error(`Expected fallback for ${rrule}, got representable`);
  }
  return r.reason;
}

// --------------------------------------------------------------
section("Daily — representable + interval cap");
// --------------------------------------------------------------
{
  const z = representable("RRULE:FREQ=DAILY;COUNT=10");
  assert(z.type === 1 && z.repeat_interval === 1 && z.end_times === 10,
    "daily count=10 → type=1 repeat_interval=1 end_times=10");
}
{
  const z = representable("RRULE:FREQ=DAILY;INTERVAL=3;COUNT=5");
  assert(z.type === 1 && z.repeat_interval === 3 && z.end_times === 5,
    "daily interval=3 count=5 → type=1 repeat_interval=3 end_times=5");
}
{
  const z = representable("RRULE:FREQ=DAILY;UNTIL=20260601T120000Z");
  assert(z.type === 1 && z.end_date_time === "2026-06-01T12:00:00Z" && z.end_times == null,
    "daily UNTIL → end_date_time, no end_times");
}
{
  const r = fallbackReason("RRULE:FREQ=DAILY;INTERVAL=91;COUNT=5");
  assert(r === "daily_interval_too_large", "daily INTERVAL>90 → daily_interval_too_large");
}

// --------------------------------------------------------------
section("Weekly — single + multi BYDAY, INTERVAL constraints");
// --------------------------------------------------------------
{
  const z = representable("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8");
  assert(z.type === 2 && z.weekly_days === "3" && z.end_times === 8,
    "weekly BYDAY=TU → weekly_days='3'");
}
{
  const z = representable("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12");
  assert(z.type === 2 && z.weekly_days === "2,4,6" && z.repeat_interval === 1,
    "weekly multi-BYDAY (interval=1) → weekly_days='2,4,6'");
}
{
  const z = representable("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=6");
  assert(z.type === 2 && z.repeat_interval === 2 && z.weekly_days === "3",
    "weekly INTERVAL=2 single BYDAY representable");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10");
  assert(r === "weekly_interval_with_multi_day",
    "weekly INTERVAL>1 + multi-BYDAY → weekly_interval_with_multi_day");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;INTERVAL=13;BYDAY=TU;COUNT=4");
  assert(r === "weekly_interval_too_large",
    "weekly INTERVAL>12 → weekly_interval_too_large");
}
{
  const z = representable("RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=4");
  assert(z.weekly_days === "1", "Sunday encodes as 1 (Zoom 1=Sun)");
}
{
  const z = representable("RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=4");
  assert(z.weekly_days === "7", "Saturday encodes as 7");
}

// --------------------------------------------------------------
section("Monthly — BYMONTHDAY + BYDAY+BYSETPOS");
// --------------------------------------------------------------
{
  const z = representable("RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6");
  assert(z.type === 3 && z.monthly_day === 15 && z.monthly_week == null,
    "monthly BYMONTHDAY=15 → type=3 monthly_day=15");
}
{
  const z = representable("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1;COUNT=6");
  assert(z.type === 3 && z.monthly_week === 1 && z.monthly_week_day === 2,
    "monthly first Monday (BYDAY+BYSETPOS=1) → monthly_week=1 monthly_week_day=2");
}
{
  const z = representable("RRULE:FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1;COUNT=6");
  assert(z.type === 3 && z.monthly_week === -1 && z.monthly_week_day === 6,
    "monthly last Friday (BYSETPOS=-1) → monthly_week=-1 monthly_week_day=6");
}
{
  const z = representable("RRULE:FREQ=MONTHLY;BYDAY=-1MO;COUNT=4");
  assert(z.type === 3 && z.monthly_week === -1 && z.monthly_week_day === 2,
    "monthly last Monday via positional BYDAY (-1MO) → monthly_week=-1 monthly_week_day=2");
}
{
  const z = representable("RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=4");
  assert(z.type === 3 && z.monthly_week === 2 && z.monthly_week_day === 3,
    "monthly 2nd Tuesday via positional BYDAY (2TU)");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=5;COUNT=6");
  assert(r === "complex_bysetpos",
    "monthly BYSETPOS=5 (not in {1,2,3,4,-1}) → complex_bysetpos");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1,3;COUNT=6");
  assert(r === "complex_bysetpos",
    "monthly multi-BYSETPOS → complex_bysetpos");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=6");
  assert(r === "monthly_bymonthday_multi",
    "monthly multi-BYMONTHDAY → monthly_bymonthday_multi");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6");
  assert(r === "monthly_bymonthday_negative",
    "monthly BYMONTHDAY=-1 (last day) → monthly_bymonthday_negative");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1;COUNT=6");
  assert(r === "monthly_byday_unsupported",
    "monthly multi-BYDAY weekday → monthly_byday_unsupported");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;COUNT=6");
  assert(r === "monthly_missing_day_or_position",
    "monthly with neither BYMONTHDAY nor BYDAY → monthly_missing_day_or_position");
}
{
  const r = fallbackReason("RRULE:FREQ=MONTHLY;INTERVAL=4;BYMONTHDAY=15;COUNT=4");
  assert(r === "monthly_interval_too_large",
    "monthly INTERVAL>3 → monthly_interval_too_large");
}

// --------------------------------------------------------------
section("Always-fallback cases (yearly / EXDATE / open-ended)");
// --------------------------------------------------------------
{
  const r = fallbackReason("RRULE:FREQ=YEARLY;COUNT=5");
  assert(r === "yearly_not_supported", "yearly → yearly_not_supported");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8", [
    new Date("2026-02-10T15:00:00Z"),
  ]);
  assert(r === "exdate_present", "EXDATE present → exdate_present");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;BYDAY=TU");
  assert(r === "end_times_too_large",
    "no COUNT/UNTIL → end_times_too_large (Zoom requires one)");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=51");
  assert(r === "end_times_too_large", "COUNT>50 → end_times_too_large");
}

// --------------------------------------------------------------
section("Unsupported BYxxx components");
// --------------------------------------------------------------
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;COUNT=4");
  assert(r === "byhour_byminute_unsupported", "BYHOUR → byhour_byminute_unsupported");
}
{
  const r = fallbackReason("RRULE:FREQ=WEEKLY;BYDAY=TU;BYWEEKNO=10;COUNT=4");
  assert(r === "byweekno_unsupported", "BYWEEKNO → byweekno_unsupported");
}

console.log(`\n${passed} passed, ${failed} failed`);
// The shared test teardown in server/db.ts disables the pg-pool idle reaper
// and unref's idle sockets in test mode, so the loop drains and the process
// exits on its own once the assertions settle — no manual process.exit() (Task #2084).
if (failed > 0) process.exitCode = 1;
