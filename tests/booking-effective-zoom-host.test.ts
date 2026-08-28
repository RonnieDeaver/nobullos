/* test-registration
{
  "name": "Booking effective Zoom host (Task #932)",
  "scanPaths": [
    "server/routes/booking.ts",
    "server/services/bookingScheduler.ts",
    "server/services/zoomIntegration.ts"
  ],
  "tier": "medium",
  "tierReason": "Covers effective-host resolution across booking routes and scheduler configuration."
}
test-registration */
/**
 * Task #932 (929C) — Canonical effective Zoom host resolver adoption.
 *
 * Pins:
 *   1. Static — the canonical helper exists and is adopted by the
 *      readiness route + the booking saga.
 *   2. Runtime — `resolveEffectiveZoomHostForUser` honors the three
 *      branches:
 *        a. With override → returns the override host (no Zoom call).
 *        b. Without override + valid app email → returns the
 *           auto-resolved host with `source: "app_email"`.
 *        c. Without override + missing Zoom user → returns
 *           `source: "none"` with a structured `error`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

async function main(): Promise<void> {
  section("1. Static — helper exists and is adopted by every call site");

  const zoomSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/zoomIntegration.ts"),
    "utf8",
  );
  assert(
    /export async function resolveEffectiveZoomHostForUser/.test(zoomSrc),
    "resolveEffectiveZoomHostForUser is exported",
  );
  assert(
    /source:\s*"override"\s*\|\s*"app_email"\s*\|\s*"none"/.test(zoomSrc),
    "EffectiveZoomHost.source union covers override | app_email | none",
  );

  const routesSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/routes/booking.ts"),
    "utf8",
  );
  // Readiness route migrated.
  // The readiness handler is ~3 KB; size the slice generously so future
  // additions to the route don't push the asserted lines out of range.
  const readinessSlice = routesSrc.slice(
    routesSrc.indexOf('"/api/booking/me/readiness"'),
    routesSrc.indexOf('"/api/booking/me/readiness"') + 5000,
  );
  assert(
    readinessSlice.includes("resolveEffectiveZoomHostForUser"),
    "readiness route uses resolveEffectiveZoomHostForUser",
  );
  assert(
    readinessSlice.includes("source: effective.source"),
    "readiness payload exposes effective host source",
  );

  // Booking saga migrated.
  const schedulerSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/bookingScheduler.ts"),
    "utf8",
  );
  assert(
    /resolveEffectiveZoomHostForUser/.test(schedulerSrc),
    "booking saga calls resolveEffectiveZoomHostForUser",
  );
  assert(
    /effectiveHost\.source === "none"/.test(schedulerSrc) &&
      /"zoom_failure"/.test(schedulerSrc),
    "saga treats source:'none' as a hard zoom_failure",
  );
  assert(
    /hostEmail:\s*effectiveHost\.zoomEmail/.test(schedulerSrc),
    "saga forwards effectiveHost.zoomEmail (not raw req.host.hostEmail) to createScheduledMeeting",
  );
  // No raw req.host.hostEmail leak into createScheduledMeeting.
  const createCallSlice = schedulerSrc.slice(
    schedulerSrc.indexOf("zoom.createScheduledMeeting({"),
    schedulerSrc.indexOf("zoom.createScheduledMeeting({") + 400,
  );
  assert(
    !createCallSlice.includes("req.host.hostEmail"),
    "saga no longer passes req.host.hostEmail directly to Zoom create",
  );

  section("2. Runtime — resolveEffectiveZoomHostForUser branches");

  const {
    resolveEffectiveZoomHostForUser,
    __primeZoomUserCacheForTest,
  } = await import("../server/services/zoomIntegration");

  // (a) With override — no Zoom call needed; helper returns the
  // validated metadata captured on the last successful PUT.
  const overrideUser = {
    id: "u-override",
    email: "am-app-login@example.invalid",
    zoomHostOverrideEmail: "real-zoom@example.invalid",
    zoomHostOverrideUserId: "ZUSER_OVERRIDE",
    zoomHostOverrideValidatedEmail: "real-zoom@example.invalid",
    zoomHostOverrideValidatedAt: new Date("2026-05-01T00:00:00Z"),
    zoomHostOverrideDisplayName: "Real Zoom Owner",
  };
  const fromOverride = await resolveEffectiveZoomHostForUser(overrideUser);
  assert(
    fromOverride.source === "override" &&
      fromOverride.zoomUserId === "ZUSER_OVERRIDE" &&
      fromOverride.zoomEmail === "real-zoom@example.invalid" &&
      fromOverride.displayName === "Real Zoom Owner",
    "override → returns override host with validated metadata",
  );

  // (b) Without override + valid app email — primed positive cache
  // ensures we don't hit the network.
  const autoEmail = "task932-auto@example.invalid";
  __primeZoomUserCacheForTest(
    { email: autoEmail },
    { id: "ZUSER_AUTO", email: autoEmail, name: "Auto Resolved" },
  );
  const fromAuto = await resolveEffectiveZoomHostForUser({
    id: "u-auto",
    email: autoEmail,
  });
  assert(
    fromAuto.source === "app_email" &&
      fromAuto.zoomUserId === "ZUSER_AUTO" &&
      fromAuto.zoomEmail === autoEmail &&
      fromAuto.displayName === "Auto Resolved",
    "no override + valid app email → returns auto-resolved host",
  );

  // (c) Without override + missing Zoom user — primed negative cache.
  const missEmail = "task932-miss@example.invalid";
  __primeZoomUserCacheForTest({ email: missEmail }, null);
  const fromMiss = await resolveEffectiveZoomHostForUser({
    id: "u-miss",
    email: missEmail,
  });
  assert(
    fromMiss.source === "none" &&
      typeof fromMiss.error === "string" &&
      fromMiss.error.length > 0,
    "no override + missing Zoom user → source:'none' with error",
  );

  // (d) Null user — defensive.
  const fromNull = await resolveEffectiveZoomHostForUser(null);
  assert(
    fromNull.source === "none" && !!fromNull.error,
    "null user → source:'none' with error",
  );

  // (d2) Override-only host (no app email) — locks the parity behavior
  // the code review called out: an AM with no `users.email` but a
  // validated override must still resolve to the override host. This
  // mirrors what the readiness card and the booking saga both rely on.
  const overrideOnlyUser = {
    id: "u-override-only",
    email: null,
    zoomHostOverrideEmail: "override-only-zoom@example.invalid",
    zoomHostOverrideUserId: "ZUSER_OVERRIDE_ONLY",
    zoomHostOverrideValidatedEmail: "override-only-zoom@example.invalid",
    zoomHostOverrideValidatedAt: new Date("2026-05-08T00:00:00Z"),
    zoomHostOverrideDisplayName: "Override Only",
  };
  const fromOverrideOnly =
    await resolveEffectiveZoomHostForUser(overrideOnlyUser);
  assert(
    fromOverrideOnly.source === "override" &&
      fromOverrideOnly.zoomEmail === "override-only-zoom@example.invalid" &&
      fromOverrideOnly.zoomUserId === "ZUSER_OVERRIDE_ONLY",
    "override-only user (no app email) still resolves via override",
  );

  // Additional static guard: BookHostInput.hostEmail is now optional
  // and the saga no longer hard-validates it, so override-only booking
  // can flow end-to-end past the saga's input validation.
  const schedulerSrc2 = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/bookingScheduler.ts"),
    "utf8",
  );
  assert(
    /hostEmail\?:\s*string\s*\|\s*null/.test(schedulerSrc2),
    "BookHostInput.hostEmail is optional (override-only bookings supported)",
  );
  assert(
    !/if \(!req\.host\.hostEmail\)/.test(schedulerSrc2),
    "saga no longer rejects when req.host.hostEmail is missing",
  );

  // Route-level prechecks must also allow override-only bookings.
  const routesSrc2 = fs.readFileSync(
    path.resolve(process.cwd(), "server/routes/booking.ts"),
    "utf8",
  );
  assert(
    /!am\.email && !am\.zoomHostOverrideEmail && !am\.zoomHostOverrideUserId/.test(
      routesSrc2,
    ),
    "/api/book/:slug/confirm allows override-only AM (no app email)",
  );
  assert(
    /!user\.email && !user\.zoomHostOverrideEmail && !user\.zoomHostOverrideUserId/.test(
      routesSrc2,
    ),
    "AM client-book route allows override-only user (no app email)",
  );

  // (e) No app email and no override → source:'none' with email-specific error.
  const fromEmpty = await resolveEffectiveZoomHostForUser({
    id: "u-empty",
    email: null,
  });
  assert(
    fromEmpty.source === "none" && /email/i.test(fromEmpty.error || ""),
    "no email + no override → source:'none' with email-specific error",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
main().catch((err) => {
  console.error("Test crashed:", err);
  process.exitCode = 1;
});
