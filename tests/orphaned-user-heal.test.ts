/* test-registration
{
  "name": "Orphaned-user profile-row heal sweep — RETIRED short-circuit (Tasks #2203 → #4554)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4554 closed admission: the users table is the sign-in allowlist, so the Replit-Auth-era heal sweep (which re-created users rows from session claims) MUST stay inert — even when its enable switch is ON — or it resurrects exactly the unapproved accounts the allowlist keeps out. This locks the unconditional short-circuit (no scan, no writes, retirement reason) plus the surviving budget-parse helper. Fast and deterministic under the hermetic per-run test DB.",
  "tier": "small"
}
test-registration */
/**
 * Task #2203 built this sweep to heal logged-in users still missing their
 * `users` profile row (Replit-Auth-era fail-open admission). Task #4554
 * RETIRED it: closed admission makes the `users` table the sign-in
 * allowlist — rows are created only via admin approval (POST /api/users) —
 * and re-upserting a session-with-no-row from its claims would re-create
 * exactly the auto-provisioned accounts the allowlist exists to keep out.
 *
 * The tick now short-circuits unconditionally, BEFORE the enable switch,
 * so flipping `orphaned_user_heal_enabled` back on can never resurrect the
 * write path. Deterministic units (DB-backed, no live integrations):
 *
 *   1. Default (switch unset): tick no-ops with the retirement reason and
 *      never creates a `users` row for a live orphaned session.
 *   2. Switch forced ON + a live orphaned session seeded: STILL healed=0,
 *      candidates=0, attempted empty, no row created — the short-circuit
 *      beats the enable gate (the regression this suite exists to catch).
 *   3. The tick still persists a readable last-run summary (status
 *      surfaces show the retirement instead of a vanished feature).
 *   4. `loadMaxPerTick` parses + bounds the surviving per-tick budget
 *      setting (config surface kept for the status routes).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  runOrphanedUserHealTick,
  getLastOrphanedUserHealRun,
  SETTING_ENABLED,
  SETTING_MAX_PER_TICK,
  __orphanedUserHealTestHelpers,
} from "../server/services/orphanedUserHeal";

const TAG = "task-2203";

interface SeededSession {
  sid: string;
  sub: string;
  email: string;
}

/** Seed a live session whose sub has no users row — the Replit-Auth-era
 * "orphan" the sweep used to heal. Under closed admission it must stay
 * rowless forever. */
async function seedSession(): Promise<SeededSession> {
  const sub = `${TAG}-${randomUUID()}`;
  const email = `${sub}@test.example`.toLowerCase();
  const sid = `${TAG}-sid-${randomUUID()}`;
  const expire = new Date(Date.now() + 60 * 60_000);
  const sess = {
    passport: {
      user: {
        claims: {
          sub,
          email,
          first_name: "Orphaned",
          last_name: "User",
          profile_image_url: null,
        },
      },
    },
  };
  await db.execute(sql`
    INSERT INTO sessions (sid, sess, expire)
    VALUES (${sid}, ${JSON.stringify(sess)}::jsonb, ${expire.toISOString()})
  `);
  return { sid, sub, email };
}

async function fetchUser(id: string): Promise<Record<string, unknown> | null> {
  const res: any = await db.execute(
    sql`SELECT email, first_name FROM users WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : (res?.rows ?? []);
  return rows[0] ?? null;
}

async function cleanup(subs: string[], sids: string[]): Promise<void> {
  for (const sid of sids) {
    await db.execute(sql`DELETE FROM sessions WHERE sid = ${sid}`).catch(() => {});
  }
  for (const sub of subs) {
    await db.execute(sql`DELETE FROM users WHERE id = ${sub}`).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (1) default (switch unset) → retired no-op, no row created
// ─────────────────────────────────────────────────────────────────────────────

async function testDefaultRetiredNoOp(): Promise<void> {
  console.log("default (switch unset) → retired no-op, never creates a users row");
  const subs: string[] = [];
  const sids: string[] = [];
  try {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    const seeded = await seedSession();
    subs.push(seeded.sub);
    sids.push(seeded.sid);

    const result = await runOrphanedUserHealTick();

    assert.equal(result.enabled, false, "tick reports the switch as OFF");
    assert.equal(result.healed, 0, "nothing healed");
    assert.equal(result.candidates, 0, "no candidate scan ran");
    assert.equal(result.attempted.length, 0, "no attempts recorded");
    assert.match(result.reason ?? "", /retired/i, "reason states the retirement");
    assert.equal(
      await fetchUser(seeded.sub),
      null,
      "no users row was created for the orphaned session",
    );

    console.log("  ✓ default tick is a pure retired no-op");
  } finally {
    await cleanup(subs, sids);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) switch forced ON → STILL inert (the regression this suite exists for)
// ─────────────────────────────────────────────────────────────────────────────

async function testEnabledSwitchStillInert(): Promise<void> {
  console.log("switch forced ON + live orphan seeded → STILL no scan, no write");
  const subs: string[] = [];
  const sids: string[] = [];
  try {
    await setSystemSetting(SETTING_ENABLED, "true");
    const seeded = await seedSession();
    subs.push(seeded.sub);
    sids.push(seeded.sid);

    // Precondition: genuinely orphaned (live session, no users row).
    assert.equal(
      await fetchUser(seeded.sub),
      null,
      "precondition: orphaned sub has no users row",
    );

    const result = await runOrphanedUserHealTick();

    assert.equal(result.enabled, true, "tick reports the switch as ON");
    assert.equal(result.healed, 0, "healed stays 0 even when enabled");
    assert.equal(result.candidates, 0, "candidates stays 0 — no session scan");
    assert.equal(result.attempted.length, 0, "attempted stays empty");
    assert.equal(result.errors, 0, "no errors — clean short-circuit");
    assert.match(
      result.reason ?? "",
      /retired/i,
      "reason states the retirement even when the switch is ON",
    );
    assert.equal(
      await fetchUser(seeded.sub),
      null,
      "no users row created — closed admission holds against the ON switch",
    );

    console.log("  ✓ enable switch can no longer resurrect the write path");
  } finally {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    await cleanup(subs, sids);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) the tick still persists a readable last-run summary
// ─────────────────────────────────────────────────────────────────────────────

async function testLastRunPersisted(): Promise<void> {
  console.log("tick persists its retirement summary as the last-run readout");
  const result = await runOrphanedUserHealTick();
  const lastRun = await getLastOrphanedUserHealRun();
  assert.ok(lastRun, "last-run summary is persisted");
  assert.equal(lastRun!.ranAt, result.ranAt, "readout is the tick just run");
  assert.match(
    lastRun!.reason ?? "",
    /retired/i,
    "status surfaces show the retirement reason",
  );
  console.log("  ✓ status surfaces keep showing the retirement");
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) per-tick budget parsing + bounds (surviving config surface)
// ─────────────────────────────────────────────────────────────────────────────

async function testMaxPerTickBounds(): Promise<void> {
  console.log("loadMaxPerTick parses + bounds the per-tick budget");
  const { loadMaxPerTick } = __orphanedUserHealTestHelpers;
  try {
    await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
    assert.equal(await loadMaxPerTick(), 25, "default budget is 25 when unset");

    await setSystemSetting(SETTING_MAX_PER_TICK, "100");
    assert.equal(await loadMaxPerTick(), 100, "explicit valid budget is honored");

    await setSystemSetting(SETTING_MAX_PER_TICK, "99999");
    assert.equal(await loadMaxPerTick(), 500, "budget is capped at 500");

    await setSystemSetting(SETTING_MAX_PER_TICK, "0");
    assert.equal(await loadMaxPerTick(), 25, "non-positive falls back to default");

    console.log("  ✓ per-tick budget parsing + bounds hold");
  } finally {
    await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await testDefaultRetiredNoOp();
  await testEnabledSwitchStillInert();
  await testLastRunPersisted();
  await testMaxPerTickBounds();
  console.log("orphaned-user-heal: PASSED");
  process.exit(0);
}

main().catch((err) => {
  console.error("orphaned-user-heal: FAILED");
  console.error(err);
  process.exit(1);
});
