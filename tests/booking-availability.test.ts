/* test-registration
{
  "name": "Booking availability engine (Task #840)",
  "scanPaths": [
    "server/services/bookingAvailability.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #840 — Booking availability engine contract tests.
 *
 * Source-level invariants that the slot computation MUST keep:
 *   1. DST handling uses date-fns-tz (toZonedTime / fromZonedTime / formatInTimeZone),
 *      not raw Date math.
 *   2. Calendar busy + scheduled meetings + buffers all subtract from raw rule windows.
 *   3. Per-day overrides take precedence over recurring rules.
 *   4. The min-lead-minutes guard is enforced before slots are emitted.
 *   5. localDateKey / localTimeKey roundtrip via the page timezone.
 *
 * These checks intentionally avoid a real DB; they verify the API contract
 * that the routes + UI rely on, plus the timezone roundtrip.
 */

import * as fs from "fs";
import * as path from "path";

import {
  localDateKey,
  localTimeKey,
} from "../server/services/bookingAvailability";

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

const SRC = fs.readFileSync(
  path.join(process.cwd(), "server/services/bookingAvailability.ts"),
  "utf8",
);

section("1. DST-safe via date-fns-tz");
{
  assert(
    /from\s+["']date-fns-tz["']/.test(SRC),
    "imports from date-fns-tz",
  );
  assert(SRC.includes("toZonedTime"), "uses toZonedTime");
  assert(SRC.includes("fromZonedTime"), "uses fromZonedTime");
  assert(SRC.includes("formatInTimeZone"), "uses formatInTimeZone");
}

section("2. Subtracts busy intervals + buffers");
{
  assert(
    SRC.includes("calendarBusy") && SRC.includes("scheduled"),
    "merges calendar busy with scheduled meetings",
  );
  assert(
    SRC.includes("expandBusyWithBuffers"),
    "applies bufferBeforeMinutes / bufferAfterMinutes via expandBusyWithBuffers",
  );
  assert(
    SRC.includes("mergeIntervals"),
    "merges overlapping busy intervals before subtracting",
  );
}

section("3. Overrides take precedence over rules");
{
  assert(
    /listAvailabilityOverrides/.test(SRC),
    "fetches per-day overrides",
  );
  assert(
    /override(s)?/.test(SRC) && /isBlocked/.test(SRC),
    "honors isBlocked overrides",
  );
}

section("4. Min lead-time guard");
{
  assert(
    SRC.includes("minLeadMinutes") && SRC.includes("earliestBookable"),
    "computes earliestBookable from minLeadMinutes",
  );
  assert(
    /fromUtc\s*<\s*earliestBookable/.test(SRC) ||
      /earliestBookable.*fromUtc/.test(SRC),
    "clamps fromUtc to earliestBookable",
  );
}

section("5. Local date/time keys roundtrip via the page timezone");
{
  // Pick a UTC instant that falls in two different local dates depending on tz.
  const utc = new Date("2026-01-15T03:30:00Z"); // 22:30 ET, 21:30 CT, 03:30 UTC
  const pageEt = { id: "p1", timezone: "America/New_York" } as any;
  const pageCt = { id: "p1", timezone: "America/Chicago" } as any;
  const pageUtc = { id: "p1", timezone: "UTC" } as any;

  assert(localDateKey(pageEt, utc) === "2026-01-14", "ET date is the prior day");
  assert(localDateKey(pageCt, utc) === "2026-01-14", "CT date is the prior day");
  assert(localDateKey(pageUtc, utc) === "2026-01-15", "UTC date is unchanged");

  assert(localTimeKey(pageEt, utc) === "22:30", "ET time correctly offset");
  assert(localTimeKey(pageCt, utc) === "21:30", "CT time correctly offset");
  assert(localTimeKey(pageUtc, utc) === "03:30", "UTC time matches");
}

section("6. DST transition — Spring forward (2026-03-08 in US/Central)");
{
  // 07:30 UTC on the morning of DST transition is 02:30 CST (just before the
  // 02:00→03:00 jump in CT). Verify we still land on the correct local date.
  const beforeJump = new Date("2026-03-08T07:30:00Z");
  const pageCt = { id: "p1", timezone: "America/Chicago" } as any;
  // Either way it's still 2026-03-08 locally — main point is we don't crash
  // and we use the tz-aware formatter rather than naive UTC math.
  assert(
    localDateKey(pageCt, beforeJump) === "2026-03-08",
    "still resolves DST-day local date",
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
process.exitCode = failed > 0 ? 1 : 0;
