/* test-registration
{
  "name": "Booking recurrence (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
// future-date-literal-reviewed: the 2027-01-01/2027-12-31 dates are pinned RRULE expansion window bounds compared against pinned dtstart fixtures (literal-vs-literal, no real-clock comparison) — they cannot rot when the calendar passes them.
/**
 * Task #1032A — Recurrence validator + expander unit tests.
 *
 * Phase-1 contract checks. No DB, no HTTP — pure helper behavior.
 */

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  validateRecurrencePayload,
  expandRecurrence,
} from "../server/services/bookingRecurrence";
import type { NormalizedRecurrence } from "@shared/schema";

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

function mustValidate(rrule: string[], timezone: string): NormalizedRecurrence {
  const r = validateRecurrencePayload({ rrule, timezone });
  if (!r.ok) {
    throw new Error(`Expected validation OK, got ${r.code}: ${r.message}`);
  }
  return r.normalized;
}

// --------------------------------------------------------------
section("Validator rejections");
// --------------------------------------------------------------
{
  const r = validateRecurrencePayload({
    rrule: ["RRULE:NOTAFREQ=BAD"],
    timezone: "America/Chicago",
  });
  assert(!r.ok && (r as any).code === "recurrence_invalid_rrule",
    "rejects invalid RRULE syntax");
}
{
  const r = validateRecurrencePayload({
    rrule: ["RRULE:INTERVAL=1"],
    timezone: "America/Chicago",
  });
  assert(!r.ok && (r as any).code === "recurrence_invalid_rrule",
    "rejects RRULE missing FREQ");
}
{
  const r = validateRecurrencePayload({
    rrule: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    timezone: "Mars/Olympus_Mons",
  });
  assert(!r.ok && (r as any).code === "recurrence_invalid_timezone",
    "rejects unknown IANA timezone");
}
{
  const r = validateRecurrencePayload({
    rrule: ["RRULE:FREQ=WEEKLY;COUNT=4;UNTIL=20260301T000000Z"],
    timezone: "America/Chicago",
  });
  assert(!r.ok && (r as any).code === "recurrence_count_until_conflict",
    "rejects RRULE with both COUNT and UNTIL");
}
{
  const r = validateRecurrencePayload({
    rrule: [
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4",
      "EXDATE;TZID=America/New_York:20260106T090000",
    ],
    timezone: "America/Chicago",
  });
  assert(!r.ok && (r as any).code === "recurrence_exdate_timezone_mismatch",
    "rejects EXDATE TZID that doesn't match recurrence tz");
}
{
  // Build 60 *valid* EXDATE entries — daily for Jan + Feb, 2026.
  const exdates: string[] = [];
  let cursor = new Date(Date.UTC(2026, 0, 1));
  for (let i = 0; i < 60; i++) {
    const y = cursor.getUTCFullYear();
    const m = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cursor.getUTCDate()).padStart(2, "0");
    exdates.push(`EXDATE;TZID=America/Chicago:${y}${m}${d}T090000`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const r = validateRecurrencePayload({
    rrule: ["RRULE:FREQ=DAILY;COUNT=200", ...exdates],
    timezone: "America/Chicago",
  });
  assert(!r.ok && (r as any).code === "recurrence_too_many_exdates",
    "rejects payloads exceeding the EXDATE cap");
}

// --------------------------------------------------------------
section("Validator success + EXDATE parsing");
// --------------------------------------------------------------
{
  const r = mustValidate(
    [
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4",
      "EXDATE;TZID=America/Chicago:20260113T090000",
    ],
    "America/Chicago",
  );
  assert(r.exdates.length === 1, "parses one EXDATE entry");
  assert(r.timezone === "America/Chicago", "preserves timezone");
  assert(r.rruleLine.startsWith("RRULE:FREQ=WEEKLY"), "preserves rrule line");
}

// First Tuesday of 2026 at 9 AM Chicago.
const FIRST_TUE_9AM_CT = fromZonedTime(
  "2026-01-06T09:00:00",
  "America/Chicago",
);

// --------------------------------------------------------------
section("Expander — weekly Tuesday for 4 weeks");
// --------------------------------------------------------------
{
  const normalized = mustValidate(
    ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4"],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart: FIRST_TUE_9AM_CT,
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-04-01T00:00:00Z"),
    durationMinutes: 60,
  });
  assert(r.ok && (r as any).occurrences.length === 4, "yields 4 occurrences");
  if (r.ok) {
    const localTimes = r.occurrences.map((o) =>
      formatInTimeZone(o.start, "America/Chicago", "yyyy-MM-dd HH:mm")
    );
    assert(
      localTimes.every((s) => s.endsWith("09:00")),
      "every occurrence is at 09:00 local Chicago time",
    );
  }
}

// --------------------------------------------------------------
section("Expander — every other Tuesday COUNT=10");
// --------------------------------------------------------------
{
  const normalized = mustValidate(
    ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=10"],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart: FIRST_TUE_9AM_CT,
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2027-01-01T00:00:00Z"),
    durationMinutes: 30,
  });
  assert(r.ok && (r as any).occurrences.length === 10, "yields 10 biweekly occurrences");
  if (r.ok) {
    const diffs: number[] = [];
    for (let i = 1; i < r.occurrences.length; i++) {
      diffs.push(
        (r.occurrences[i].start.getTime() - r.occurrences[i - 1].start.getTime()) /
          (24 * 60 * 60 * 1000),
      );
    }
    assert(diffs.every((d) => Math.abs(d - 14) < 1), "biweekly spacing of ~14 days");
  }
}

// --------------------------------------------------------------
section("Expander — monthly last Friday for 6 months");
// --------------------------------------------------------------
{
  // Last Friday of January 2026 = Jan 30, 2 PM Chicago.
  const dtstart = fromZonedTime("2026-01-30T14:00:00", "America/Chicago");
  const normalized = mustValidate(
    ["RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6"],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart,
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2027-01-01T00:00:00Z"),
    durationMinutes: 60,
  });
  assert(r.ok && (r as any).occurrences.length === 6, "yields 6 monthly occurrences");
  if (r.ok) {
    const allFridays = r.occurrences.every((o) =>
      formatInTimeZone(o.start, "America/Chicago", "EEEE") === "Friday"
    );
    assert(allFridays, "every occurrence falls on a Friday in Chicago");
  }
}

// --------------------------------------------------------------
section("Expander — EXDATE drops the right instance");
// --------------------------------------------------------------
{
  const normalized = mustValidate(
    [
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4",
      "EXDATE;TZID=America/Chicago:20260113T090000",
    ],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart: FIRST_TUE_9AM_CT,
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2026-04-01T00:00:00Z"),
    durationMinutes: 60,
  });
  assert(r.ok && (r as any).occurrences.length === 3, "EXDATE drops one occurrence (3 of 4 remain)");
  if (r.ok) {
    const dates = r.occurrences.map((o) =>
      formatInTimeZone(o.start, "America/Chicago", "yyyy-MM-dd")
    );
    assert(!dates.includes("2026-01-13"), "Jan 13 is excluded");
    assert(
      dates.includes("2026-01-06") &&
        dates.includes("2026-01-20") &&
        dates.includes("2026-01-27"),
      "Jan 6, 20, and 27 remain",
    );
  }
}

// --------------------------------------------------------------
section("Expander — DST safety (spring + fall boundaries)");
// --------------------------------------------------------------
{
  // Weekly 9 AM Chicago, spans both 2026 DST transitions:
  //   spring-forward = 2026-03-08, fall-back = 2026-11-01.
  const dtstart = fromZonedTime("2026-02-03T09:00:00", "America/Chicago");
  const normalized = mustValidate(
    ["RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=45"],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart,
    from: new Date("2026-02-01T00:00:00Z"),
    to: new Date("2027-01-01T00:00:00Z"),
    durationMinutes: 60,
    maxOccurrences: 50,
  });
  assert(r.ok && (r as any).occurrences.length === 45, "expander emits all 45 weekly occurrences");
  if (r.ok) {
    const localTimes = r.occurrences.map((o) =>
      formatInTimeZone(o.start, "America/Chicago", "HH:mm")
    );
    const allNine = localTimes.every((t) => t === "09:00");
    assert(allNine, "every occurrence stays at 09:00 Chicago across spring + fall DST");
    const utcHours = new Set(r.occurrences.map((o) => o.start.getUTCHours()));
    assert(utcHours.size >= 2, "UTC hour shifts across DST (sanity)");
  }
}

// --------------------------------------------------------------
section("Expander — cap exceeded => truncated:true");
// --------------------------------------------------------------
{
  const normalized = mustValidate(
    ["RRULE:FREQ=DAILY;COUNT=500"],
    "America/Chicago",
  );
  const r = expandRecurrence(normalized, {
    dtstart: FIRST_TUE_9AM_CT,
    from: new Date("2026-01-01T00:00:00Z"),
    to: new Date("2027-12-31T00:00:00Z"),
    durationMinutes: 30,
    maxOccurrences: 25,
  });
  assert(r.ok && (r as any).occurrences.length === 25, "yields exactly maxOccurrences");
  assert(r.ok && (r as any).truncated === true, "marks result as truncated");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
