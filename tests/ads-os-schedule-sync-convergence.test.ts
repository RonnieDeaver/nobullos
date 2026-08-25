/* test-registration
{
  "name": "Ads OS schedule sync prod action — isolated-schema convergence: status→pending when schedule mismatches or doc absent, apply→applied (patches existing + seeds absent), re-status→not-needed; non-schedule fields preserved after patch (Task #4821, Task #4827)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4821 / Task #4827: prod-action convergence gate for syncAdsOsClientSchedulesAction. Without this test a schedule mismatch, field-clobber bug, or missing-criteria-doc silent-skip in status()/apply() could ship silently and misplace client ad budgets. DB-only (no HTTP, no network); single-row isolated schema; completes well within the smoke budget.",
  "tier": "small"
}
test-registration */
/**
 * Isolated-schema convergence test for syncAdsOsClientSchedulesAction
 * (Task #4821, Task #4827).
 *
 * Verifies four claims against the real DB layer (no stub deps):
 *   (A) status() reports "pending" when a seeded criteria doc has a
 *       schedule that differs from the authoritative target list, AND when
 *       a client has no stored doc at all (absent entries are seeded on Apply
 *       so they appear as pending in status rather than being silently skipped).
 *   (B) apply() reports "applied", patches ONLY the schedule fields of an
 *       existing doc, and leaves all other criteria fields (business_name,
 *       notes, service_area, and custom legacy keys) verbatim in the stored
 *       doc.
 *   (C) apply() seeds a minimal criteria doc (schedule fields only) for
 *       clients whose doc is absent, so the pacing engine gets the correct
 *       schedule_days / lsa_schedule_days rather than treating every day as
 *       a run day (Task #4827).
 *   (D) A second status() call reports "not-needed" once all stored schedules
 *       match the authoritative list (including newly seeded absent entries).
 *
 * Hermetic: runInIsolatedSchema clones ads_os_clients_criteria so the prod
 * action's getCriteriaStrict / putCriteria calls never touch the real store.
 * pinGetDbForCrossAsync ensures the action's internal Promise.all fan-out
 * (status reads all 29 SCHEDULE_SYNC_TARGETS in parallel) also resolves
 * through the isolated schema.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

const { runInIsolatedSchema } = await import("./db-sandbox");
const { syncAdsOsClientSchedulesAction, SCHEDULE_SYNC_TARGETS } = await import(
  "../server/services/prodActions/platformOpsActions"
);

// Pick a well-known entry with a gads schedule target so we can seed a
// mismatch and later verify convergence. Ackah Law — first in the list,
// gads target: Mon–Fri, lsa: null (GAds-only entry).
const TARGET_ENTRY = SCHEDULE_SYNC_TARGETS.find((e) => e.cid === "6320038010");
assert(TARGET_ENTRY, "SCHEDULE_SYNC_TARGETS must include Ackah Law (CID 6320038010)");

// Pick a second entry that has BOTH gads and lsa targets so we can verify
// seeding covers both schedule fields. Dellutri Law: Mon–Fri for both.
const ABSENT_ENTRY = SCHEDULE_SYNC_TARGETS.find((e) => e.cid === "9446178488");
assert(ABSENT_ENTRY, "SCHEDULE_SYNC_TARGETS must include Dellutri Law (CID 9446178488)");
assert(ABSENT_ENTRY.gads !== null, "ABSENT_ENTRY must have a gads target for seeding test");
assert(ABSENT_ENTRY.lsa !== null, "ABSENT_ENTRY must have a lsa target for seeding test");

// ── Main ─────────────────────────────────────────────────────────────────────

await runInIsolatedSchema(
  async ({ db }) => {
    // ── (A) Seed a criteria doc with a WRONG schedule and extra fields ─────
    //
    // schedule_days is empty [] but the target is Mon–Fri — a clear mismatch.
    // business_name, notes, service_area, and a custom legacy key must all
    // survive the patch untouched (apply only spreads over schedule fields).
    // ABSENT_ENTRY (Dellutri Law) is intentionally NOT seeded — it stays
    // absent to exercise the seeding path in apply().
    const seedDoc = {
      business_name: "Ackah Law Test Firm",
      website: "https://ackah.example.com",
      service_area: "Atlanta, GA",
      notes: "important client notes — must survive apply",
      practice_areas: ["Immigration Law", "Family Law"],
      schedule_days: [], // MISMATCH: target is ["Mon","Tue","Wed","Thu","Fri"]
      lsa_schedule_days: [], // lsa: null means this field is NOT patched by apply
      legacy_custom_field: "legacy_value_must_survive",
      updated_at: "2024-01-15T10:00:00.000Z",
    };

    // Direct insert so the store reads it back via getCriteriaStrict.
    const seedJson = JSON.stringify(seedDoc);
    await db.execute(sql`
      INSERT INTO ads_os_clients_criteria (key, data, updated_at)
      VALUES (${TARGET_ENTRY.cid}, ${seedJson}::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE
        SET data = EXCLUDED.data,
            updated_at = EXCLUDED.updated_at
    `);

    // Verify ABSENT_ENTRY has no doc in the isolated schema (sanity check).
    const preCheck = await db.execute(sql`
      SELECT 1 FROM ads_os_clients_criteria WHERE key = ${ABSENT_ENTRY.cid}
    `);
    assert.equal(
      (preCheck.rows as any[]).length,
      0,
      "ABSENT_ENTRY must have no stored doc before status() is called",
    );

    // ── (A) status() → pending (includes both mismatch and absent clients) ──
    const status1 = await syncAdsOsClientSchedulesAction.status();
    assert.equal(
      status1.state,
      "pending",
      `(A) status must be 'pending' when a stored schedule mismatches the target, got '${status1.state}': ${status1.detail}`,
    );
    // Must mention the mismatching client or 'schedule'.
    assert.ok(
      status1.detail?.includes("Ackah Law") || status1.detail?.includes("schedule"),
      `(A) status detail should mention the mismatching client or 'schedule': ${status1.detail}`,
    );
    // Must also surface absent clients so operators know which need attention
    // (Task #4827: absent clients are seeded on Apply, so they appear as
    // pending here rather than being silently ignored).
    assert.ok(
      status1.detail?.includes("no stored criteria doc") ||
        status1.detail?.includes("absent") ||
        status1.detail?.includes("seeded"),
      `(A) status detail must surface absent clients (Task #4827): ${status1.detail}`,
    );
    console.log(`  ✓ A: status=pending (${status1.detail?.slice(0, 120)}…)`);

    // ── (B) apply() → applied; schedule patched; other fields preserved ───
    const apply1 = await syncAdsOsClientSchedulesAction.apply();
    assert.equal(
      apply1.state,
      "applied",
      `(B) apply must return 'applied' when there is at least one mismatch or absent doc, got '${apply1.state}': ${apply1.detail}`,
    );
    assert.ok(
      (apply1 as any).rowsAffected >= 1,
      `(B) rowsAffected must be ≥ 1 (updated + seeded), got ${(apply1 as any).rowsAffected}`,
    );
    console.log(`  ✓ B1: apply=applied (${apply1.detail?.slice(0, 120)}…)`);

    // Read the patched doc directly to verify field-level correctness.
    const afterApply = await db.execute(sql`
      SELECT data FROM ads_os_clients_criteria WHERE key = ${TARGET_ENTRY.cid}
    `);
    const rawRow = (afterApply.rows as any[])[0];
    assert.ok(rawRow, "(B) patched doc must still exist in the store");
    const patched: Record<string, any> =
      typeof rawRow.data === "string" ? JSON.parse(rawRow.data) : rawRow.data;

    // Schedule fields: GAds target applied.
    assert.deepEqual(
      [...(patched.schedule_days ?? [])].sort(),
      [...(TARGET_ENTRY.gads ?? [])].sort(),
      `(B) schedule_days must equal target after apply — got ${JSON.stringify(patched.schedule_days)}`,
    );

    // lsa: null in this entry → lsa_schedule_days must be untouched.
    assert.deepEqual(
      patched.lsa_schedule_days,
      seedDoc.lsa_schedule_days,
      `(B) lsa_schedule_days must be untouched (entry.lsa=null) — got ${JSON.stringify(patched.lsa_schedule_days)}`,
    );

    // Non-schedule fields preserved verbatim.
    assert.equal(
      patched.business_name,
      seedDoc.business_name,
      "(B) business_name must be preserved after apply",
    );
    assert.equal(
      patched.notes,
      seedDoc.notes,
      "(B) notes must be preserved after apply",
    );
    assert.equal(
      patched.service_area,
      seedDoc.service_area,
      "(B) service_area must be preserved after apply",
    );
    assert.deepEqual(
      patched.practice_areas,
      seedDoc.practice_areas,
      "(B) practice_areas must be preserved after apply",
    );
    assert.equal(
      patched.legacy_custom_field,
      seedDoc.legacy_custom_field,
      "(B) legacy custom field must be preserved verbatim",
    );

    // updated_at must have advanced (apply refreshes it).
    assert.ok(
      patched.updated_at !== seedDoc.updated_at,
      `(B) updated_at must be refreshed after apply (was '${seedDoc.updated_at}', still '${patched.updated_at}')`,
    );

    console.log(
      "  ✓ B2: schedule_days patched to target; lsa_schedule_days untouched; " +
      "business_name/notes/service_area/practice_areas/legacy_custom_field all preserved; updated_at refreshed",
    );

    // ── (C) apply() seeded a minimal doc for the absent client ────────────
    //
    // Task #4827: clients with no stored criteria doc must receive a seed doc
    // containing only the schedule fields so the pacing engine gets the correct
    // schedule_days / lsa_schedule_days rather than treating every day as a
    // run day (the empty-schedule default).
    const seededRow = await db.execute(sql`
      SELECT data FROM ads_os_clients_criteria WHERE key = ${ABSENT_ENTRY.cid}
    `);
    assert.equal(
      (seededRow.rows as any[]).length,
      1,
      `(C) apply must seed a criteria doc for absent client ${ABSENT_ENTRY.client} (CID ${ABSENT_ENTRY.cid})`,
    );
    const seededDoc: Record<string, any> =
      typeof (seededRow.rows as any[])[0].data === "string"
        ? JSON.parse((seededRow.rows as any[])[0].data)
        : (seededRow.rows as any[])[0].data;

    // schedule_days must equal the authoritative gads target.
    assert.deepEqual(
      [...(seededDoc.schedule_days ?? [])].sort(),
      [...(ABSENT_ENTRY.gads ?? [])].sort(),
      `(C) seeded schedule_days must equal the authoritative target — got ${JSON.stringify(seededDoc.schedule_days)}`,
    );
    // lsa_schedule_days must equal the authoritative lsa target.
    assert.deepEqual(
      [...(seededDoc.lsa_schedule_days ?? [])].sort(),
      [...(ABSENT_ENTRY.lsa ?? [])].sort(),
      `(C) seeded lsa_schedule_days must equal the authoritative target — got ${JSON.stringify(seededDoc.lsa_schedule_days)}`,
    );
    // updated_at must be present (seeded doc carries a timestamp).
    assert.ok(
      typeof seededDoc.updated_at === "string" && seededDoc.updated_at.length > 0,
      `(C) seeded doc must carry an updated_at timestamp`,
    );
    // The seed must NOT clobber any fields that were never part of the schedule
    // (the minimal doc should contain only schedule + updated_at, no invented
    // fields like business_name that belong to the operator's "Edit criteria"
    // workflow).
    assert.equal(
      seededDoc.business_name,
      undefined,
      "(C) seeded doc must not invent a business_name — only schedule fields are seeded",
    );
    console.log(
      `  ✓ C: absent client '${ABSENT_ENTRY.client}' seeded with ` +
      `schedule_days=${JSON.stringify(seededDoc.schedule_days)}, ` +
      `lsa_schedule_days=${JSON.stringify(seededDoc.lsa_schedule_days)}`,
    );

    // ── (D) status() → not-needed after apply ─────────────────────────────
    const status2 = await syncAdsOsClientSchedulesAction.status();
    assert.equal(
      status2.state,
      "not-needed",
      `(D) status must be 'not-needed' after apply converges all stored schedules (including seeded absent entries), got '${status2.state}': ${status2.detail}`,
    );
    console.log(`  ✓ D: re-status=not-needed (${status2.detail})`);

    console.log(
      "\nads-os-schedule-sync-convergence: all assertions passed (Task #4821, Task #4827).",
    );
  },
  {
    // Clone only the criteria store: the action reads/writes
    // ads_os_clients_criteria exclusively (no users, no pacing stores).
    // pinGetDbForCrossAsync ensures the action's Promise.all fan-out in
    // status() routes every parallel getCriteriaStrict call through the
    // isolated schema rather than the real public one.
    tables: ["ads_os_clients_criteria"],
    pinGetDbForCrossAsync: true,
  },
);
