/* test-registration
{
  "name": "Prod actions authority backfill (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Regression test for `backfill_user_authority_from_legacy_role`.
 *
 * Confirms the action:
 *  (a) elevates core users whose legacy role is ceo/team_lead,
 *  (b) NEVER demotes a legitimate director (whose legacy role is
 *      'team_lead' because deriveLegacyRole is lossy on lead/director),
 *  (c) leaves already-elevated rows untouched,
 *  (d) is idempotent (second press = not-needed).
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const TAG = "task-authority-backfill";
const CEO_ID = `${TAG}-ceo`;
const LEAD_ID = `${TAG}-lead`;
const DIR_ID = `${TAG}-director`;
const CORE_ID = `${TAG}-core`;

async function seed(): Promise<void> {
  // CEO that has not yet been backfilled (legacy state).
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${CEO_ID}, 'ceo', 'core', ${TAG})
    ON CONFLICT (id) DO UPDATE
      SET role = 'ceo', authority_level = 'core', first_name = ${TAG}
  `);
  // team_lead that has not yet been backfilled.
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${LEAD_ID}, 'team_lead', 'core', ${TAG})
    ON CONFLICT (id) DO UPDATE
      SET role = 'team_lead', authority_level = 'core', first_name = ${TAG}
  `);
  // Director — legacy role bridge maps director → team_lead.
  // This row MUST survive the backfill unchanged.
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${DIR_ID}, 'team_lead', 'director', ${TAG})
    ON CONFLICT (id) DO UPDATE
      SET role = 'team_lead', authority_level = 'director', first_name = ${TAG}
  `);
  // Plain core — must stay core (no elevated legacy role).
  await db.execute(sql`
    INSERT INTO users (id, role, authority_level, first_name)
    VALUES (${CORE_ID}, 'account_manager', 'core', ${TAG})
    ON CONFLICT (id) DO UPDATE
      SET role = 'account_manager', authority_level = 'core', first_name = ${TAG}
  `);
}

async function cleanup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM users WHERE id IN (${CEO_ID}, ${LEAD_ID}, ${DIR_ID}, ${CORE_ID})
  `);
}

async function getAuth(id: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT authority_level FROM users WHERE id = ${id}`);
  return ((r.rows as any[])[0]?.authority_level ?? null) as string | null;
}

async function run(): Promise<void> {
  const action = PROD_ACTIONS.find(
    (a) => a.id === "backfill_user_authority_from_legacy_role",
  );
  assert(action, "backfill action must be registered");

  await cleanup();
  await seed();

  try {
    const status1 = await action.status();
    assert.equal(status1.state, "pending", `(a) expected pending, got ${status1.state}`);
    console.log(`  ok  (a) status=pending (${status1.detail})`);

    const apply1 = await action.apply();
    assert.equal(apply1.state, "applied", `(b) expected applied, got ${apply1.state}`);
    console.log(`  ok  (b) apply=applied rowsAffected=${apply1.rowsAffected}`);

    assert.equal(await getAuth(CEO_ID), "ceo", "(c) ceo user must be elevated to ceo");
    assert.equal(await getAuth(LEAD_ID), "lead", "(c) team_lead user must be elevated to lead");
    assert.equal(
      await getAuth(DIR_ID),
      "director",
      "(c) director with role=team_lead MUST stay director (no demotion)",
    );
    assert.equal(await getAuth(CORE_ID), "core", "(c) plain core must stay core");
    console.log("  ok  (c) ceo→ceo, team_lead→lead, director preserved, core unchanged");

    const status2 = await action.status();
    assert.equal(status2.state, "not-needed", `(d) expected not-needed, got ${status2.state}`);
    const apply2 = await action.apply();
    assert.equal(apply2.state, "not-needed", `(d) second apply must be not-needed`);
    console.log("  ok  (d) idempotent — second press not-needed");

    console.log("prod-actions-authority-backfill: all assertions passed");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
run()
  .then(() => {})
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
