/* test-registration
{
  "name": "Prod action cleanup legacy keyword spellings (baseline triage, Task #3424)",
  "tier": "small"
}
test-registration */
/**
 * Task #2476 — End-to-end verification of the
 * `cleanup_legacy_keyword_spellings` CEO prod-action: a one-press,
 * idempotent, worker-pool background drain that rewrites any legacy
 * non-canonical `heatmap_snapshots.keyword_name` to its canonical form
 * (trim, collapse internal whitespace, lowercase — mirroring
 * `normalizeKeyword`) and then ensures the migration-0061 canonical CHECK
 * constraint is present.
 *
 * Everything runs inside `runInIsolatedSchema` (Task #1929 pattern) so the
 * live `Start application` workers (default search_path = public) can
 * neither see nor race-write the rows this test seeds.
 *
 * The cloned `heatmap_snapshots` table carries the canonical CHECK
 * constraint forward (the sandbox clones via `LIKE … INCLUDING ALL`), and
 * that constraint physically blocks inserting a non-canonical spelling. So,
 * exactly as memory note `heatmap-keyword-canonical-constraint.md`
 * prescribes, the tests DROP the constraint before seeding variant rows and
 * rely on the action itself to re-ADD it — which is precisely the
 * constraint-ensure branch under test.
 *
 * Coverage:
 *   1. rewrite + constraint-ensure: non-canonical rows are canonicalized,
 *      canonical negatives are untouched, the dropped constraint is
 *      re-added, and the audit tally (countPending == processed) matches.
 *   2. constraint-only: zero non-canonical rows but the constraint is
 *      missing → the drain does one unit of work (adds the constraint).
 *   3. not-needed: all canonical + constraint present → apply() reports
 *      `not-needed`, launches no drain, and writes no audit row.
 */

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";
import {
  getDrainState,
  __resetDrainsForTest,
  type DrainState,
} from "../server/services/prodActionBackgroundDrain";
import { CANONICAL_KEYWORD_CONSTRAINT_NAME } from "../server/services/legacyKeywordSpellingCleanup";
import { runInIsolatedSchema } from "./db-sandbox";

const ACTION = "cleanup_legacy_keyword_spellings";
const TABLES = ["heatmap_snapshots", "prod_action_runs"] as const;

type IsoDb = Parameters<Parameters<typeof runInIsolatedSchema>[0]>[0]["db"];

let passed = 0;
function ok(msg: string): void {
  passed++;
  console.log(`  ok  ${msg}`);
}

function getAction(id: string) {
  const action = PROD_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`${id} missing from PROD_ACTIONS registry`);
  return action;
}

async function awaitDrain(actionId: string, timeoutMs = 20_000): Promise<DrainState> {
  const start = Date.now();
  for (;;) {
    const st = getDrainState(actionId);
    if (st && st.finishedAt !== null) return st;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `drain ${actionId} did not finish within ${timeoutMs}ms (state=${JSON.stringify(st)})`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function dropCanonicalConstraint(isoDb: IsoDb): Promise<void> {
  await isoDb.execute(
    sql`ALTER TABLE heatmap_snapshots DROP CONSTRAINT IF EXISTS ${sql.raw(CANONICAL_KEYWORD_CONSTRAINT_NAME)}`,
  );
}

async function constraintPresent(isoDb: IsoDb): Promise<boolean> {
  const res: any = await isoDb.execute(sql`
    SELECT 1 FROM pg_constraint
    WHERE conname = ${CANONICAL_KEYWORD_CONSTRAINT_NAME}
      AND conrelid = 'heatmap_snapshots'::regclass
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.length > 0;
}

let seedCounter = 0;
async function seedSnapshot(isoDb: IsoDb, keywordName: string): Promise<string> {
  const id = `kw-seed-${seedCounter++}`;
  await isoDb.execute(sql`
    INSERT INTO heatmap_snapshots
      (id, location_id, location_name, campaign_id, keyword_name, report_date,
       business_lat, business_lng, grid_template, grid_unit, grid_distance,
       base_lat, base_lng, raw_payload, created_at)
    VALUES (
      ${id}, 'loc-1', 'Loc One', 'camp-1', ${keywordName}, NOW(),
      0, 0, '5x5', 'MILES', 1, 0, 0, '{}'::jsonb, NOW()
    )
  `);
  return id;
}

async function keywordOf(isoDb: IsoDb, id: string): Promise<string | null> {
  const res: any = await isoDb.execute(
    sql`SELECT keyword_name FROM heatmap_snapshots WHERE id = ${id}`,
  );
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  return rows.length ? String(rows[0].keyword_name) : null;
}

async function auditRow(
  isoDb: IsoDb,
): Promise<{ outcome_state: string; rows_affected: number } | null> {
  const res: any = await isoDb.execute(sql`
    SELECT outcome_state, rows_affected FROM prod_action_runs WHERE action_id = ${ACTION}
  `);
  const rows = Array.isArray(res) ? res : res?.rows ?? [];
  if (rows.length === 0) return null;
  assert.equal(rows.length, 1, `expected exactly one audit row, got ${rows.length}`);
  return {
    outcome_state: String(rows[0].outcome_state),
    rows_affected: Number(rows[0].rows_affected),
  };
}

// ─── 1: rewrite non-canonical rows + re-add the dropped constraint ─────
async function testRewriteAndEnsureConstraint(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // The clone carries the CHECK constraint; drop it so we can seed legacy
    // non-canonical spellings. The action must re-ADD it at the end.
    await dropCanonicalConstraint(isoDb);

    // Non-canonical (matching) rows — mixed case / padded / doubled spaces.
    const upper = await seedSnapshot(isoDb, "Plumber");
    const padded = await seedSnapshot(isoDb, "  immigration attorney  ");
    const doubled = await seedSnapshot(isoDb, "car  accident   lawyer");
    // Canonical (negative) rows the rewrite must leave byte-for-byte alone.
    const neg1 = await seedSnapshot(isoDb, "plumber near me");
    const neg2 = await seedSnapshot(isoDb, "dui defense");

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

    const state = await awaitDrain(ACTION);
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    // countPending = 3 non-canonical + 1 (constraint missing) = 4.
    assert.equal(state.totalAtStart, 4, `countPending should be 4, got ${state.totalAtStart}`);
    assert.equal(state.processed, 4, `processed should be 4, got ${state.processed}`);
    assert.deepEqual(
      state.perKey,
      { rewritten: 3, constraint_added: 1 },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );

    // Rewrites land on the canonical form.
    assert.equal(await keywordOf(isoDb, upper), "plumber");
    assert.equal(await keywordOf(isoDb, padded), "immigration attorney");
    assert.equal(await keywordOf(isoDb, doubled), "car accident lawyer");
    // Canonical negatives untouched.
    assert.equal(await keywordOf(isoDb, neg1), "plumber near me");
    assert.equal(await keywordOf(isoDb, neg2), "dui defense");

    // The constraint was re-added so the invariant is durable again.
    assert.equal(await constraintPresent(isoDb), true, "canonical CHECK constraint must be present");

    const audit = await auditRow(isoDb);
    assert(audit, "no prod_action_runs audit row was written");
    assert.equal(audit.outcome_state, "applied");
    assert.equal(audit.rows_affected, 4, `audit rows_affected should be 4, got ${audit.rows_affected}`);
    ok(`${ACTION}: rewrote 3 non-canonical rows + re-added constraint, 2 negatives untouched, tally correct`);
  }, { tables: TABLES });
}

// ─── 2: zero non-canonical rows but constraint missing → ensure only ──
async function testConstraintOnly(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    await dropCanonicalConstraint(isoDb);
    // Only canonical rows, but the constraint is gone → 1 unit of work.
    const neg = await seedSnapshot(isoDb, "estate planning");

    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "applied", `expected applied, got ${JSON.stringify(out)}`);

    const state = await awaitDrain(ACTION);
    assert.equal(state.error, null, `drain errored — ${state.error}`);
    assert.equal(state.totalAtStart, 1, `countPending should be 1, got ${state.totalAtStart}`);
    assert.equal(state.processed, 1, `processed should be 1, got ${state.processed}`);
    assert.deepEqual(
      state.perKey,
      { constraint_added: 1 },
      `unexpected perKey ${JSON.stringify(state.perKey)}`,
    );

    assert.equal(await keywordOf(isoDb, neg), "estate planning");
    assert.equal(await constraintPresent(isoDb), true, "constraint must be re-added");

    const audit = await auditRow(isoDb);
    assert(audit, "no audit row written");
    assert.equal(audit.rows_affected, 1);
    ok(`${ACTION}: missing-constraint-only → drain adds it (1 unit), canonical row untouched`);
  }, { tables: TABLES });
}

// ─── 3: all canonical + constraint present → not-needed, no audit ─────
async function testNotNeeded(): Promise<void> {
  await runInIsolatedSchema(async ({ db: isoDb }) => {
    __resetDrainsForTest();
    // Leave the cloned constraint in place; seed only canonical rows.
    const a = await seedSnapshot(isoDb, "workers comp");
    const b = await seedSnapshot(isoDb, "personal injury");

    // status() reflects the converged state before any press.
    //
    // Task #3785 — status() consults the AMBIENT pool (public schema), not
    // the isolated clone; a sibling sweep suite (heatmap canonical-constraint
    // test) legitimately DROPs the public constraint for a few seconds and
    // re-ADDs it in its finally. Poll briefly so that short window can't
    // flap this suite in the full sweep.
    let st = await getAction(ACTION).status();
    for (let i = 0; i < 90 && st.state !== "not-needed"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await getAction(ACTION).status();
    }
    assert.equal(st.state, "not-needed", `status should be not-needed, got ${JSON.stringify(st)}`);

    // Note: deliberately a SINGLE press. Re-pressing while a sibling has the
    // public constraint dropped would launch a real ambient drain that
    // rewrites the sibling's variant-spelling fixture rows. The 90s status
    // poll above already gates the press on a constraint-present window.
    const out = await getAction(ACTION).apply(null);
    assert.equal(out.state, "not-needed", `apply should be not-needed, got ${JSON.stringify(out)}`);
    assert.equal(getDrainState(ACTION), undefined, "no drain may be created when nothing to do");
    assert.equal(await auditRow(isoDb), null, "no audit row may be written for a no-op press");

    assert.equal(await keywordOf(isoDb, a), "workers comp");
    assert.equal(await keywordOf(isoDb, b), "personal injury");
    ok(`${ACTION}: all canonical + constraint present → not-needed, no drain, no audit row`);
  }, { tables: TABLES });
}

async function main(): Promise<void> {
  await testRewriteAndEnsureConstraint();
  await testConstraintOnly();
  await testNotNeeded();
  console.log(`\nprod-action-cleanup-legacy-keyword-spellings: ${passed} assertions passed`);
}

main().then(
  () => {
    console.log("prod-action-cleanup-legacy-keyword-spellings: verified");
  },
  (err) => {
    console.error("prod-action-cleanup-legacy-keyword-spellings: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  },
);
