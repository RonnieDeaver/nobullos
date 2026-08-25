/* test-registration
{
  "name": "Restored-fallback email auto-cleanup (Task #2029)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.0s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "tier": "small"
}
test-registration */
/**
 * Task #2029 — Automatically clean up restored-fallback emails.
 *
 * Pins the bounded cleanup driver that scans active users whose email
 * matches the `<original>.restored.<ts>` fallback pattern (left behind
 * by Task #1910's suffix-fallback restore) and auto-restores the
 * original address when it is free.
 *
 * Deterministic units (DB-backed, no live integrations):
 *   1. `runRestoredEmailCleanupTick` no-ops with a reason when the
 *      master enable setting is OFF (default) — never mutates.
 *   2. When enabled, a fallback-email user whose original is free is
 *      repaired back to the original address and a system-attributed
 *      (null userId) `user_email_updated` activity row is written.
 *   3. A fallback-email user whose original still collides with another
 *      active user is left untouched (outcome "collision").
 *   4. `loadMaxPerTick` parses + bounds the per-tick budget.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import {
  setSystemSetting,
  deleteSystemSetting,
} from "../server/storage/settingsStorage";
import {
  runRestoredEmailCleanupTick,
  readLastRestoredEmailCleanupRun,
  getLastRestoredEmailCleanupRun,
  SETTING_ENABLED,
  SETTING_LAST_RUN,
  SETTING_MAX_PER_TICK,
  __restoredEmailCleanupTestHelpers,
} from "../server/services/restoredEmailCleanup";

const TAG = "task-2029";

async function seedUser(email: string): Promise<string> {
  const id = `${TAG}-${randomUUID()}`;
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${id}, ${email}, ${TAG}, 'User', 'user', 'core')
  `);
  return id;
}

async function fetchEmail(id: string): Promise<string | null> {
  const res: any = await db.execute(
    sql`SELECT email FROM users WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : (res?.rows ?? []);
  return rows[0] ? (rows[0].email as string | null) : null;
}

async function cleanupUsers(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const literal = `{${ids.join(",")}}`;
  await db.execute(sql`
    DELETE FROM user_activity_logs
    WHERE (metadata->>'targetUserId') = ANY(${literal}::text[])
  `);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${literal}::text[])`);
}

test("task-2029: disabled by default — tick no-ops without mutating", async () => {
  await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
  const ts = Date.now();
  const original = `${TAG}-disabled-${ts}@test.example`;
  const fallback = `${original}.restored.${ts}`;
  const id = await seedUser(fallback);
  try {
    const r = await runRestoredEmailCleanupTick();
    assert.equal(r.enabled, false);
    assert.equal(r.repaired, 0);
    assert.match(r.reason ?? "", /disabled/i);
    // Untouched.
    assert.equal(await fetchEmail(id), fallback);
  } finally {
    await cleanupUsers([id]);
  }
});

test("task-2029: enabled — repairs a free original and logs system audit", async () => {
  await setSystemSetting(SETTING_ENABLED, "true");
  const ts = Date.now();
  const original = `${TAG}-free-${ts}@test.example`;
  const fallback = `${original}.restored.${ts}`;
  const id = await seedUser(fallback);
  try {
    const r = await runRestoredEmailCleanupTick();
    assert.equal(r.enabled, true);
    const mine = r.attempted.find((a) => a.userId === id);
    assert.ok(mine, "expected our user to be attempted");
    assert.equal(mine!.outcome, "repaired");
    assert.equal(await fetchEmail(id), original);

    const logs: any = await db.execute(sql`
      SELECT user_id, action_type, metadata
      FROM user_activity_logs
      WHERE (metadata->>'targetUserId') = ${id}
    `);
    const rows = Array.isArray(logs) ? logs : (logs?.rows ?? []);
    assert.equal(rows.length, 1, "expected exactly one audit row");
    assert.equal(rows[0].user_id, null, "system-attributed (null userId)");
    assert.equal(rows[0].action_type, "user_email_updated");
    assert.equal(rows[0].metadata?.newEmail ?? null, original);
    assert.equal(rows[0].metadata?.priorEmail ?? null, fallback);
  } finally {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    await cleanupUsers([id]);
  }
});

test("task-2029: enabled — leaves a still-colliding original untouched", async () => {
  await setSystemSetting(SETTING_ENABLED, "true");
  const ts = Date.now();
  const original = `${TAG}-collide-${ts}@test.example`;
  const fallback = `${original}.restored.${ts}`;
  // An active user already owns the original address.
  const colliderId = await seedUser(original);
  const fallbackId = await seedUser(fallback);
  try {
    const r = await runRestoredEmailCleanupTick();
    const mine = r.attempted.find((a) => a.userId === fallbackId);
    assert.ok(mine, "expected our fallback user to be attempted");
    assert.equal(mine!.outcome, "collision");
    // Left on the fallback address for manual cleanup.
    assert.equal(await fetchEmail(fallbackId), fallback);
  } finally {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    await cleanupUsers([colliderId, fallbackId]);
  }
});

test("task-2198: readLastRestoredEmailCleanupRun classifies never_run vs unreadable", async () => {
  // never_run — no persisted setting row.
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  const neverRun = await readLastRestoredEmailCleanupRun();
  assert.equal(neverRun.status, "never_run");
  assert.equal(neverRun.lastRun, null);
  assert.equal(neverRun.error, undefined);

  // unreadable — stored value is not valid JSON.
  await setSystemSetting(SETTING_LAST_RUN, "{not json");
  const corruptParse = await readLastRestoredEmailCleanupRun();
  assert.equal(corruptParse.status, "unreadable");
  assert.equal(corruptParse.lastRun, null);
  assert.ok(
    typeof corruptParse.error === "string" && corruptParse.error.length > 0,
    "unreadable carries a plain-English error",
  );

  // unreadable — valid JSON but not an object.
  await setSystemSetting(SETTING_LAST_RUN, "42");
  const corruptShape = await readLastRestoredEmailCleanupRun();
  assert.equal(corruptShape.status, "unreadable");
  assert.equal(corruptShape.lastRun, null);

  // Back-compat wrapper collapses both non-ok states to null.
  await deleteSystemSetting(SETTING_LAST_RUN).catch(() => {});
  assert.equal(await getLastRestoredEmailCleanupRun(), null);
});

// ── Task #2044 — alert when restored emails are stuck on collisions ──

import {
  SETTING_COLLISION_ALERT_THRESHOLD,
  SETTING_COLLISION_STUCK_HOURS,
  SETTING_COLLISION_ALERT_STATE,
  parseRestoredFallbackTimestamp,
} from "../server/services/restoredEmailCleanup";

const ESCALATION_DEDUPE_KEY = "restored-email-collision-stuck";
const TEST_ADMIN_ID = "task-2044-collision-alert-admin";

async function seedAdmin(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name, role, authority_level)
    VALUES (${TEST_ADMIN_ID}, ${`${TEST_ADMIN_ID}@example.test`}, ${TAG}, 'Admin', 'team_lead', 'core')
    ON CONFLICT (id) DO UPDATE SET role = 'team_lead', deleted_at = NULL
  `);
}

async function clearAdmin(): Promise<void> {
  // user_notifications FK is ON DELETE CASCADE, so this clears its inbox too.
  await db
    .execute(sql`DELETE FROM users WHERE id = ${TEST_ADMIN_ID}`)
    .catch(() => {});
  await db
    .execute(
      sql`DELETE FROM user_notifications WHERE dedupe_key = ${ESCALATION_DEDUPE_KEY}`,
    )
    .catch(() => {});
}

test("task-2044: parseRestoredFallbackTimestamp extracts the suffix epoch", () => {
  const ts = 1_700_000_000_000;
  assert.equal(
    parseRestoredFallbackTimestamp(`bob@x.example.restored.${ts}`),
    ts,
  );
  assert.equal(parseRestoredFallbackTimestamp("bob@x.example"), null);
  assert.equal(parseRestoredFallbackTimestamp(null), null);
  assert.equal(parseRestoredFallbackTimestamp("bob@x.example.restored.0"), null);
});

test("task-2044: collision alert thresholds parse and bound", async () => {
  const { loadCollisionAlertThreshold, loadCollisionStuckHours } =
    __restoredEmailCleanupTestHelpers;

  await deleteSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD).catch(() => {});
  assert.equal(await loadCollisionAlertThreshold(), 1, "default threshold");
  await setSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD, "0");
  assert.equal(await loadCollisionAlertThreshold(), 1, "non-positive -> default");
  await setSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD, "5");
  assert.equal(await loadCollisionAlertThreshold(), 5);
  await deleteSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD).catch(() => {});

  await deleteSystemSetting(SETTING_COLLISION_STUCK_HOURS).catch(() => {});
  assert.equal(await loadCollisionStuckHours(), 24, "default stuck hours");
  await setSystemSetting(SETTING_COLLISION_STUCK_HOURS, "100000");
  assert.equal(await loadCollisionStuckHours(), 24 * 30, "capped at 30 days");
  await deleteSystemSetting(SETTING_COLLISION_STUCK_HOURS).catch(() => {});
});

test("task-2044: stuck collisions are counted, sampled, and alerted once per streak", async () => {
  await seedAdmin();
  await setSystemSetting(SETTING_ENABLED, "true");
  await setSystemSetting(SETTING_COLLISION_STUCK_HOURS, "1");
  // Huge threshold first so the baseline run never fires.
  await setSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD, "1000000");
  await deleteSystemSetting(SETTING_COLLISION_ALERT_STATE).catch(() => {});

  const ts = Date.now();
  const original = `${TAG}-stuck-${ts}@test.example`;
  // Fallback minted 2h ago (older than the 1h stuck threshold).
  const fallback = `${original}.restored.${ts - 2 * 3_600_000}`;
  const colliderId = await seedUser(original);
  const fallbackId = await seedUser(fallback);

  try {
    // Baseline: measure pre-existing stuck collisions (none of ours fire).
    const baseline = (await runRestoredEmailCleanupTick()).stuckCollisions;
    assert.ok(baseline >= 1, "our seeded collision counts in the baseline");

    // Now arm a threshold that only our collision pushes us over, and
    // re-arm the streak flag.
    await setSystemSetting(
      SETTING_COLLISION_ALERT_THRESHOLD,
      String(baseline),
    );
    await deleteSystemSetting(SETTING_COLLISION_ALERT_STATE).catch(() => {});

    const r1 = await runRestoredEmailCleanupTick();
    assert.equal(r1.stuckCollisions, baseline, "stuck count stable");
    const mine = r1.stuckCollisionSample.find((s) => s.userId === fallbackId);
    assert.ok(mine, "our stuck user is named in the sample");
    assert.equal(mine!.originalEmail, original.toLowerCase());
    assert.equal(mine!.collidingUserId, colliderId);
    assert.ok((mine!.stuckHours ?? 0) >= 1, "stuck hours derived from suffix");
    assert.equal(r1.collisionAlertFired, true, "fresh streak fires the alert");

    const state1 = await __restoredEmailCleanupTestHelpers.readCollisionAlertState();
    assert.equal(state1.alerted, true);
    const firedAt = state1.lastFiredAt;

    // The alert reached our seeded admin's inbox.
    const inbox: any = await db.execute(sql`
      SELECT id FROM user_notifications
      WHERE user_id = ${TEST_ADMIN_ID} AND dedupe_key = ${ESCALATION_DEDUPE_KEY}
    `);
    assert.ok((inbox.rows?.length ?? 0) >= 1, "admin received the alert");

    // Second tick with the same stuck set must NOT re-fire.
    const r2 = await runRestoredEmailCleanupTick();
    assert.equal(r2.collisionAlertFired, false, "no re-fire within a streak");
    const state2 = await __restoredEmailCleanupTestHelpers.readCollisionAlertState();
    assert.equal(state2.lastFiredAt, firedAt, "streak fire timestamp unchanged");

    // Resolve the collision (free the original) → the fallback user is
    // repaired, the stuck count drops below threshold, the alert re-arms.
    await cleanupUsers([colliderId]);
    const r3 = await runRestoredEmailCleanupTick();
    assert.equal(await fetchEmail(fallbackId), original.toLowerCase());
    const state3 = await __restoredEmailCleanupTestHelpers.readCollisionAlertState();
    assert.equal(state3.alerted, false, "re-armed once below threshold");
  } finally {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    await deleteSystemSetting(SETTING_COLLISION_STUCK_HOURS).catch(() => {});
    await deleteSystemSetting(SETTING_COLLISION_ALERT_THRESHOLD).catch(() => {});
    await deleteSystemSetting(SETTING_COLLISION_ALERT_STATE).catch(() => {});
    await cleanupUsers([colliderId, fallbackId]);
    await clearAdmin();
  }
});

test("task-2044: a collision younger than the stuck window is not alerted", async () => {
  await setSystemSetting(SETTING_ENABLED, "true");
  await setSystemSetting(SETTING_COLLISION_STUCK_HOURS, "24");
  const ts = Date.now();
  const original = `${TAG}-fresh-${ts}@test.example`;
  // Minted just now — well under the 24h stuck window.
  const fallback = `${original}.restored.${ts}`;
  const colliderId = await seedUser(original);
  const fallbackId = await seedUser(fallback);
  try {
    const { computeStuckCollisions } = __restoredEmailCleanupTestHelpers;
    const { stripRestoredFallbackSuffix } = await import(
      "../server/storage/clientStorage"
    );
    const stuck = computeStuckCollisions({
      users: [
        { id: colliderId, email: original },
        { id: fallbackId, email: fallback },
      ],
      candidates: [{ id: fallbackId, email: fallback }],
      now: new Date(),
      stuckHours: 24,
      stripRestoredFallbackSuffix,
    });
    assert.equal(stuck.length, 0, "young collision is below the stuck window");
  } finally {
    await deleteSystemSetting(SETTING_ENABLED).catch(() => {});
    await deleteSystemSetting(SETTING_COLLISION_STUCK_HOURS).catch(() => {});
    await cleanupUsers([colliderId, fallbackId]);
  }
});

test("task-2044: a recipient-lookup failure does not arm the streak — a later healthy tick still alerts", async () => {
  const { maybeAlertStuckCollisions, readCollisionAlertState, writeCollisionAlertState } =
    __restoredEmailCleanupTestHelpers;

  const stuck = [
    {
      userId: "u1",
      fallbackEmail: "x@y.example.restored.1",
      originalEmail: "x@y.example",
      collidingUserId: "owner",
      stuckSince: null,
      stuckHours: 99,
    },
  ];
  const users = [
    { id: "u1", email: "x@y.example.restored.1", firstName: "Stuck", lastName: "User" },
    { id: "owner", email: "x@y.example", firstName: "Real", lastName: "Owner" },
  ];

  // Start un-armed.
  await writeCollisionAlertState({ alerted: false });

  // Tick 1: recipient resolution "fails" (returns [] like the swallowed
  // DB-error path). The alert is NOT delivered, so the streak must stay
  // un-armed for a retry next tick.
  let notified = 0;
  const fired1 = await maybeAlertStuckCollisions({
    stuck,
    threshold: 1,
    stuckHours: 24,
    users,
    resolveAdmins: async () => [],
    notify: async () => {
      notified += 1;
    },
  });
  assert.equal(fired1, false, "no alert fired when recipients unresolved");
  assert.equal(notified, 0, "notifyUser not called");
  const afterFail = await readCollisionAlertState();
  assert.equal(afterFail.alerted, false, "streak NOT armed after lookup failure");

  // Tick 2: recipients resolve healthily — the alert must still fire even
  // though the count never dropped below threshold.
  const fired2 = await maybeAlertStuckCollisions({
    stuck,
    threshold: 1,
    stuckHours: 24,
    users,
    resolveAdmins: async () => ["admin-1"],
    notify: async () => {
      notified += 1;
    },
  });
  assert.equal(fired2, true, "healthy tick fires the deferred alert");
  assert.equal(notified, 1, "notifyUser called once on the healthy tick");
  const afterFire = await readCollisionAlertState();
  assert.equal(afterFire.alerted, true, "streak armed only after a real send");

  await deleteSystemSetting(SETTING_COLLISION_ALERT_STATE).catch(() => {});
});

test("task-2044: every fallback aimed at one collided original is counted", async () => {
  const { computeStuckCollisions } = __restoredEmailCleanupTestHelpers;
  const { stripRestoredFallbackSuffix } = await import(
    "../server/storage/clientStorage"
  );
  const old = Date.now() - 5 * 3_600_000;
  // One active owner of `shared@x.example`, two distinct restored users
  // both stuck behind that same original address.
  const stuck = computeStuckCollisions({
    users: [
      { id: "owner", email: "shared@x.example" },
      { id: "a", email: `shared@x.example.restored.${old}` },
      { id: "b", email: `shared@x.example.restored.${old - 1000}` },
    ],
    candidates: [
      { id: "a", email: `shared@x.example.restored.${old}` },
      { id: "b", email: `shared@x.example.restored.${old - 1000}` },
    ],
    now: new Date(),
    stuckHours: 1,
    stripRestoredFallbackSuffix,
  });
  assert.equal(stuck.length, 2, "both fallbacks on the same original count");
  assert.deepEqual(
    stuck.map((s) => s.userId).sort(),
    ["a", "b"],
    "each affected user is named once",
  );
  assert.ok(
    stuck.every((s) => s.collidingUserId === "owner"),
    "the colliding owner is identified for each",
  );
});

test("task-2029: loadMaxPerTick parses and bounds the per-tick budget", async () => {
  const { loadMaxPerTick } = __restoredEmailCleanupTestHelpers;

  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
  assert.equal(await loadMaxPerTick(), 25, "default when unset");

  await setSystemSetting(SETTING_MAX_PER_TICK, "5");
  assert.equal(await loadMaxPerTick(), 5);

  await setSystemSetting(SETTING_MAX_PER_TICK, "100000");
  assert.equal(await loadMaxPerTick(), 500, "capped at MAX_PER_TICK_CAP");

  await setSystemSetting(SETTING_MAX_PER_TICK, "0");
  assert.equal(await loadMaxPerTick(), 25, "non-positive falls back to default");

  await deleteSystemSetting(SETTING_MAX_PER_TICK).catch(() => {});
});
