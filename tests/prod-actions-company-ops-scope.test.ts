/* test-registration
{
  "name": "Prod action: make Company Ops departments company-wide — precheck/apply/converged/renamed-skip (Task #4893)",
  "regression": true,
  "sweepOnlyReason": "Task #4893 — DB-backed prod-action test (seeds the six pinned production UUIDs in the per-run test DB and exercises the real UPDATE convergence + renamed-id skip paths); not fast-path smoke material.",
  "extraEnv": {
    "NODE_ENV": "test"
  },
  "tier": "small"
}
test-registration */
/**
 * Task #4893 — `make_company_ops_departments_company_wide`.
 *
 * Production's 2026-07-24 taxonomy re-org created six "Company Ops – …"
 * departments at the schema-default per_client scope; per Task #4171's model
 * they must be company-wide. This suite seeds the six pinned production
 * UUIDs (safe: per-run hermetic test DB) and confirms the action:
 *  (a) is registered converging + humanGate (no lever, no self-heal),
 *  (b) reports pending while any pinned row is per_client + still named
 *      "Company Ops…",
 *  (c) flips exactly the pinned rows (updated_at bumped; a NON-pinned
 *      "Company Ops – …" decoy is never touched),
 *  (d) converges — second status/apply report not-needed,
 *  (e) skips-and-reports a pinned id renamed away from "Company Ops"
 *      (left per_client, excluded from convergence),
 *  (f) reports a deleted pinned id as no-longer-present, still not-needed.
 */

import "./helpers/forceTestEnv";

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import { db } from "../server/db";
import { PROD_ACTIONS } from "../server/services/prodActionsRegistry";

const ACTION_ID = "make_company_ops_departments_company_wide";
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

// The six production rows (prod replica read 2026-08-17; en dash U+2013) —
// the pinned-id contract the action ships with.
const PINNED: ReadonlyArray<{ id: string; name: string }> = [
  { id: "a1cddd74-6e6d-45f9-a6cf-465fae94031e", name: "Company Ops – Sales (New Business)" },
  { id: "16139020-81f8-40fd-b808-4fc60af3e72f", name: "Company Ops – Marketing" },
  { id: "12f1963f-dd58-4f50-8847-0e666fd4b580", name: "Company Ops – Operations" },
  { id: "0385e5ef-aff9-4d8c-bf54-c8310c2d676f", name: "Company Ops – HR / People" },
  { id: "c234e3e0-d1b1-499f-abb7-8fddeb0c1613", name: "Company Ops – Finance / Accounting" },
  { id: "9b6fa86c-3693-406d-8e81-551a042046a1", name: "Company Ops – IT / Systems" },
];
// Same name prefix, NOT a pinned id — must never be flipped.
const DECOY_ID = `dept-4893-decoy-${RUN}`;

async function seedAllPerClient(): Promise<void> {
  for (const d of PINNED) {
    await db.execute(sql`
      INSERT INTO sd_departments (id, name, active, sort_order, assignment_scope, updated_at)
      VALUES (${d.id}, ${d.name}, true, 9200, 'per_client', NOW() - interval '1 hour')
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, active = true, assignment_scope = 'per_client',
            updated_at = NOW() - interval '1 hour'
    `);
  }
  await db.execute(sql`
    INSERT INTO sd_departments (id, name, active, sort_order, assignment_scope)
    VALUES (${DECOY_ID}, ${`Company Ops – Decoy ${RUN}`}, true, 9201, 'per_client')
    ON CONFLICT (id) DO UPDATE SET assignment_scope = 'per_client'
  `);
}

async function cleanup(): Promise<void> {
  const ids = [...PINNED.map((d) => d.id), DECOY_ID];
  for (const id of ids) {
    await db.execute(sql`DELETE FROM sd_departments WHERE id = ${id}`).catch(() => 0);
  }
}

async function scopeOf(id: string): Promise<{ scope: string | null; name: string | null; updatedAt: Date | null }> {
  const r = await db.execute(sql`
    SELECT assignment_scope, name, updated_at FROM sd_departments WHERE id = ${id}
  `);
  const row = (r.rows as any[])[0];
  return {
    scope: row?.assignment_scope ?? null,
    name: row?.name ?? null,
    updatedAt: row?.updated_at ? new Date(row.updated_at) : null,
  };
}

async function run(): Promise<void> {
  const action = PROD_ACTIONS.find((a) => a.id === ACTION_ID);
  assert.ok(action, `(a) ${ACTION_ID} must be registered in PROD_ACTIONS`);

  // (a) declared shape — converging with a human gate (owner-timed one-shot),
  // never a lever (Apply-all must drain it) and never self-heal-enrolled.
  assert.equal(action.convergence.kind, "converging", "(a) action must be converging");
  assert.ok(
    (action.humanGate?.reason ?? "").length > 0,
    "(a) converging action must declare its humanGate reason",
  );
  assert.equal(action.manualLever, undefined, "(a) must not be a manual lever");
  assert.equal(action.selfHeal, undefined, "(a) must not be self-heal-enrolled");
  console.log("  ok  (a) registered — converging + humanGate, no lever/self-heal");

  await cleanup();
  await seedAllPerClient();
  try {
    // (b) precheck — all six pending.
    const status1 = await action.status();
    assert.equal(status1.state, "pending", `(b) expected pending, got ${status1.state}: ${status1.detail}`);
    assert.ok(
      status1.detail.includes("6 of 6"),
      `(b) pending detail must count 6 of 6 (got: ${status1.detail})`,
    );
    console.log(`  ok  (b) status=pending (${status1.detail.slice(0, 100)}…)`);

    // (c) apply — flips exactly the six pinned rows.
    const before = await scopeOf(PINNED[0].id);
    const apply1 = await action.apply();
    assert.equal(apply1.state, "applied", `(c) expected applied, got ${apply1.state}: ${(apply1 as any).detail}`);
    assert.equal(apply1.rowsAffected, 6, `(c) rowsAffected must be 6 (got ${apply1.rowsAffected})`);
    for (const d of PINNED) {
      const row = await scopeOf(d.id);
      assert.equal(row.scope, "company", `(c) ${d.name} must be company after apply`);
      assert.ok(apply1.detail.includes(d.name), `(c) applied detail must name "${d.name}"`);
    }
    const after = await scopeOf(PINNED[0].id);
    assert.ok(
      after.updatedAt!.getTime() > before.updatedAt!.getTime(),
      "(c) updated_at must advance on flip",
    );
    const decoy = await scopeOf(DECOY_ID);
    assert.equal(decoy.scope, "per_client", "(c) non-pinned Company Ops decoy must never be touched");
    console.log("  ok  (c) apply flipped exactly the 6 pinned rows (decoy untouched, updated_at bumped)");

    // (d) converged — both reads report not-needed.
    const status2 = await action.status();
    assert.equal(status2.state, "not-needed", `(d) expected not-needed, got ${status2.state}: ${status2.detail}`);
    const apply2 = await action.apply();
    assert.equal(apply2.state, "not-needed", `(d) second apply must be not-needed (got ${apply2.state})`);
    console.log("  ok  (d) converged — status and second apply both not-needed");

    // (e) renamed pinned id → skipped-and-reported, excluded from convergence.
    const renamed = PINNED[0];
    const still = PINNED[1];
    const renamedName = `Growth Experiments ${RUN}`;
    await db.execute(sql`
      UPDATE sd_departments SET assignment_scope = 'per_client', name = ${renamedName}
      WHERE id = ${renamed.id}
    `);
    await db.execute(sql`
      UPDATE sd_departments SET assignment_scope = 'per_client' WHERE id = ${still.id}
    `);
    const status3 = await action.status();
    assert.equal(status3.state, "pending", `(e) expected pending, got ${status3.state}: ${status3.detail}`);
    assert.ok(status3.detail.includes("1 of 6"), `(e) only the still-named row is flippable (got: ${status3.detail})`);
    assert.ok(
      status3.detail.includes(renamedName) && status3.detail.includes(renamed.id),
      `(e) pending detail must report the renamed skip with name + id (got: ${status3.detail})`,
    );
    const apply3 = await action.apply();
    assert.equal(apply3.state, "applied", `(e) expected applied, got ${apply3.state}: ${(apply3 as any).detail}`);
    assert.equal(apply3.rowsAffected, 1, `(e) only the still-named row flips (got ${apply3.rowsAffected})`);
    assert.ok(apply3.detail.includes(renamedName), `(e) applied detail must report the renamed skip (got: ${apply3.detail})`);
    const renamedRow = await scopeOf(renamed.id);
    assert.equal(renamedRow.scope, "per_client", "(e) renamed row must stay per_client");
    assert.equal(renamedRow.name, renamedName, "(e) renamed row's name must be untouched");
    const status4 = await action.status();
    assert.equal(
      status4.state,
      "not-needed",
      `(e) renamed residue must NOT block convergence (got ${status4.state}: ${status4.detail})`,
    );
    assert.ok(
      status4.detail.includes(renamedName),
      `(e) converged detail still reports the renamed skip (got: ${status4.detail})`,
    );
    console.log("  ok  (e) renamed pinned id skipped-and-reported, excluded from convergence");

    // (f) deleted pinned id → reported as no-longer-present, still not-needed.
    await db.execute(sql`DELETE FROM sd_departments WHERE id = ${renamed.id}`);
    const status5 = await action.status();
    assert.equal(status5.state, "not-needed", `(f) expected not-needed, got ${status5.state}: ${status5.detail}`);
    assert.ok(
      status5.detail.includes("no longer exist") && status5.detail.includes(renamed.id),
      `(f) detail must report the missing pinned id (got: ${status5.detail})`,
    );
    console.log("  ok  (f) deleted pinned id reported, convergence intact");

    console.log("prod-actions-company-ops-scope: all assertions passed (Task #4893)");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084),
// so the process exits on its own once work settles — no manual process.exit().
run()
  .then(() => {})
  .catch((err) => {
    console.error("prod-actions-company-ops-scope: FAILED —", err?.stack ?? err);
    process.exitCode = 1;
  });
