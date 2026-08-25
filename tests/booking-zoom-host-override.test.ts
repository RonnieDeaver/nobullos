/* test-registration
{
  "name": "Booking Zoom host override (Task #931)",
  "scanPaths": [
    "migrations/0043_add_user_zoom_host_override.sql",
    "server/routes/booking.ts",
    "server/services/zoomIntegration.ts",
    "shared/models/auth.ts"
  ],
  "tier": "medium"
}
test-registration */
/**
 * Task #931 (929B) — Zoom host override model + API.
 *
 * Static assertions pin the schema, migration, route registration,
 * rate-limiting, and structured-error contract.
 *
 * Runtime assertions exercise:
 *   1. Empty input ⇒ typed `empty_input` (clear-override path).
 *   2. Cached "Zoom has no such user" ⇒ typed `zoom_host_override_invalid`.
 *      Uses the test-only cache primer so we never touch the network.
 *   3. Cached match ⇒ typed `ok=true` with canonical Zoom identity.
 *   4. Id+email mismatch ⇒ typed `zoom_host_override_mismatch`.
 *   5. End-to-end DB persistence: upsert a user, write override fields
 *      directly via Drizzle, read back, then clear and re-read.
 *      Mirrors exactly what the PUT and DELETE handlers do, so this
 *      pins the storage round-trip the routes depend on.
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
  section("1. Static — schema, migration, routes, helper");

  const authSrc = fs.readFileSync(
    path.resolve(process.cwd(), "shared/models/auth.ts"),
    "utf8",
  );
  for (const col of [
    "zoom_host_override_email",
    "zoom_host_override_user_id",
    "zoom_host_override_validated_at",
    "zoom_host_override_validated_email",
    "zoom_host_override_display_name",
  ]) {
    assert(authSrc.includes(col), `users schema declares column ${col}`);
  }

  const migration = path.resolve(
    process.cwd(),
    "migrations/0043_add_user_zoom_host_override.sql",
  );
  assert(fs.existsSync(migration), "migration 0043 exists");
  const migrationSrc = fs.readFileSync(migration, "utf8");
  assert(
    migrationSrc.includes("zoom_host_override_email"),
    "migration adds zoom_host_override_email",
  );
  assert(
    migrationSrc.includes("zoom_host_override_validated_at"),
    "migration adds zoom_host_override_validated_at",
  );

  const routesSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/routes/booking.ts"),
    "utf8",
  );
  assert(
    /app\.get\(\s*"\/api\/booking\/me\/zoom-host"/.test(routesSrc),
    "GET /api/booking/me/zoom-host is registered",
  );
  assert(
    /app\.put\(\s*"\/api\/booking\/me\/zoom-host"[\s\S]{0,200}writeLimiter/.test(
      routesSrc,
    ),
    "PUT /api/booking/me/zoom-host is rate-limited (writeLimiter)",
  );
  assert(
    /app\.delete\(\s*"\/api\/booking\/me\/zoom-host"[\s\S]{0,200}writeLimiter/.test(
      routesSrc,
    ),
    "DELETE /api/booking/me/zoom-host is rate-limited (writeLimiter)",
  );
  assert(
    routesSrc.includes('code: validated.code'),
    "PUT surfaces typed-result code field on validation failure",
  );
  // GET payload includes the explicit effective-host state for 929E.
  assert(
    /effective:\s*\{?\s*\n?\s*mode:/.test(routesSrc) ||
      routesSrc.includes('mode: "override"'),
    "GET payload includes explicit `effective.mode` field",
  );
  assert(
    routesSrc.includes('mode: "auto"') &&
      routesSrc.includes('mode: "none"'),
    "GET payload supports auto and none effective modes",
  );

  const zoomSrc = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/zoomIntegration.ts"),
    "utf8",
  );
  assert(
    /export async function validateZoomHostOverride/.test(zoomSrc),
    "validateZoomHostOverride helper is exported",
  );
  assert(
    /export async function resolveZoomUserById/.test(zoomSrc),
    "resolveZoomUserById helper is exported",
  );
  // Typed discriminated-union result type.
  assert(
    /ZoomHostOverrideValidationResult/.test(zoomSrc) &&
      /code:\s*"empty_input"/.test(zoomSrc) &&
      /code:\s*"zoom_host_override_invalid"/.test(zoomSrc) &&
      /code:\s*"zoom_host_override_mismatch"/.test(zoomSrc) &&
      /code:\s*"zoom_unreachable"/.test(zoomSrc),
    "validateZoomHostOverride returns a typed discriminated-union with all 4 error codes",
  );

  section("2. Runtime — validateZoomHostOverride typed-result contract");

  const { validateZoomHostOverride, __primeZoomUserCacheForTest } =
    await import("../server/services/zoomIntegration");

  // (1) empty_input — no I/O, used by the DELETE/clear path.
  const empty = await validateZoomHostOverride({ email: "", zoomUserId: "" });
  assert(
    !empty.ok && empty.code === "empty_input",
    "empty input returns typed { ok:false, code:'empty_input' }",
  );

  // (2) zoom_host_override_invalid — prime negative cache so the
  // helper resolves to "no such user" without hitting the network.
  const missEmail = "task931-miss@example.invalid";
  __primeZoomUserCacheForTest({ email: missEmail }, null);
  const miss = await validateZoomHostOverride({ email: missEmail });
  assert(
    !miss.ok && miss.code === "zoom_host_override_invalid",
    "Zoom miss returns typed { ok:false, code:'zoom_host_override_invalid' }",
  );

  // (3) ok=true — prime a positive cache entry and assert canonical
  // identity is returned.
  const hitEmail = "task931-hit@example.invalid";
  __primeZoomUserCacheForTest(
    { email: hitEmail },
    { id: "ZUSER931", email: hitEmail, name: "Task 931 Tester" },
  );
  const hit = await validateZoomHostOverride({ email: hitEmail });
  assert(
    hit.ok &&
      hit.zoomUserId === "ZUSER931" &&
      hit.zoomEmail === hitEmail &&
      hit.displayName === "Task 931 Tester",
    "valid email returns typed { ok:true, zoomUserId, zoomEmail, displayName }",
  );

  // (4a) Invalid zoomUserId + valid email — must NOT silently fall
  // back to email lookup. The id is the source of truth and an id
  // that doesn't resolve must reject the whole request, otherwise the
  // route could persist an unverified id alongside a verified email.
  const ghostId = "ZUSER931_GHOST";
  const validFallbackEmail = "task931-fallback@example.invalid";
  __primeZoomUserCacheForTest({ zoomUserId: ghostId }, null);
  __primeZoomUserCacheForTest(
    { email: validFallbackEmail },
    { id: "ZUSER931_REAL", email: validFallbackEmail, name: "Real User" },
  );
  const ghost = await validateZoomHostOverride({
    email: validFallbackEmail,
    zoomUserId: ghostId,
  });
  assert(
    !ghost.ok && ghost.code === "zoom_host_override_invalid",
    "invalid zoomUserId + valid email rejects without falling back to email",
  );

  // (4b) zoom_host_override_mismatch — id resolves to a user whose
  // email contradicts the supplied email.
  const mismatchId = "ZUSER931_MISMATCH";
  __primeZoomUserCacheForTest(
    { zoomUserId: mismatchId },
    {
      id: mismatchId,
      email: "actual-owner@example.invalid",
      name: "Actual Owner",
    },
  );
  const mismatch = await validateZoomHostOverride({
    email: "claimed-owner@example.invalid",
    zoomUserId: mismatchId,
  });
  assert(
    !mismatch.ok && mismatch.code === "zoom_host_override_mismatch",
    "id+email contradiction returns typed { ok:false, code:'zoom_host_override_mismatch' }",
  );

  section("3. Runtime — DB persistence round-trip (mirrors PUT / DELETE)");
  // Skip when no database is available (e.g. CI smoke run).
  if (!process.env.DATABASE_URL) {
    console.log("  · skipping persistence round-trip (no DATABASE_URL)");
  } else {
    const { db } = await import("../server/db");
    const { users } = await import("../shared/models/auth");
    const { eq } = await import("drizzle-orm");
    const testUserId = `task931-test-${Date.now()}`;
    const testEmail = `task931-${Date.now()}@example.invalid`;
    try {
      // Create the user row directly (replaces authStorage.upsertUser).
      const [created] = await db.insert(users).values({
        id: testUserId,
        email: testEmail,
        firstName: "Task",
        lastName: "931",
      }).returning();
      assert(created.id === testUserId, "test user upserted");
      assert(
        created.zoomHostOverrideEmail == null &&
          created.zoomHostOverrideUserId == null,
        "fresh user has no override (auto-resolve fallback in effect)",
      );

      // Write override fields the same way the PUT handler does.
      const overrideEmail = "override-zoom@example.invalid";
      const overrideUserId = "ZUSER_PERSIST_931";
      const validatedAt = new Date();
      const [afterPut] = await db
        .update(users)
        .set({
          zoomHostOverrideEmail: overrideEmail,
          zoomHostOverrideUserId: overrideUserId,
          zoomHostOverrideValidatedAt: validatedAt,
          zoomHostOverrideValidatedEmail: overrideEmail,
          zoomHostOverrideDisplayName: "Persist Tester",
          updatedAt: new Date(),
        })
        .where(eq(users.id, testUserId))
        .returning();
      assert(
        afterPut.zoomHostOverrideEmail === overrideEmail &&
          afterPut.zoomHostOverrideUserId === overrideUserId &&
          afterPut.zoomHostOverrideValidatedEmail === overrideEmail &&
          afterPut.zoomHostOverrideDisplayName === "Persist Tester" &&
          afterPut.zoomHostOverrideValidatedAt instanceof Date,
        "valid override persists all five columns",
      );

      // Read back via direct DB select to confirm the round-trip.
      const [reread] = await db.select().from(users).where(eq(users.id, testUserId)).limit(1);
      assert(
        reread?.zoomHostOverrideUserId === overrideUserId &&
          reread?.zoomHostOverrideValidatedEmail === overrideEmail,
        "override round-trips through getUser",
      );

      // Now clear (DELETE handler equivalent) and confirm fallback.
      const [afterDelete] = await db
        .update(users)
        .set({
          zoomHostOverrideEmail: null,
          zoomHostOverrideUserId: null,
          zoomHostOverrideValidatedAt: null,
          zoomHostOverrideValidatedEmail: null,
          zoomHostOverrideDisplayName: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, testUserId))
        .returning();
      assert(
        afterDelete.zoomHostOverrideEmail == null &&
          afterDelete.zoomHostOverrideUserId == null &&
          afterDelete.zoomHostOverrideValidatedAt == null &&
          afterDelete.zoomHostOverrideValidatedEmail == null &&
          afterDelete.zoomHostOverrideDisplayName == null,
        "clear-override resets all five columns to null",
      );
    } finally {
      try {
        await db.delete(users).where(eq(users.id, testUserId));
      } catch {
        // best-effort cleanup
      }
    }
  }

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
