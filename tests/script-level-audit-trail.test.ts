/* test-registration
{
  "name": "Script-level audit trail (Task #1274)",
  "regression": true,
  "smoke": true,
  "smokeReason": "Task #4096 triage of the migrated no-reason boilerplate: fast (~0.1s in the 2026-08-07 nightly sweep) and deterministic under the hermetic per-run test DB, so it earns a routine-gate slot.",
  "scanPaths": [
    "scripts/cleanup-ghost-gbp-locations.ts",
    "scripts/import-demo-data.ts",
    "scripts/verification-fixtures.ts"
  ],
  "tier": "small"
}
test-registration */
/**
 * Task #1274 — Script-level audit trail regression.
 *
 * Three operational scripts write to `report_sections` outside the normal
 * request path. After Task #1273 they each either route through
 * `upsertReportSection` or seed a paired `report_section_history` row by
 * hand. This test pins that audit behavior so a future refactor cannot
 * silently re-introduce the gap.
 *
 * Scripts under test:
 *   1. `scripts/import-demo-data.ts`
 *        - editor = "script:import-demo-data", source = "migration_seed"
 *        - Bypasses `upsertReportSection` because it must preserve exact
 *          `id` values from the export file; pairs every write with a
 *          manual `report_section_history` row.
 *   2. `scripts/cleanup-ghost-gbp-locations.ts`
 *        - editor = "script:cleanup-ghost-gbp-locations", source = "system"
 *        - Surgical JSONB patch on existing sections by `sectionId`;
 *          pairs the raw UPDATE with a manual history row.
 *   3. `scripts/verification-fixtures.ts`
 *        - editor = "script:verification-fixtures", source = "migration_seed"
 *        - Routes through `upsertReportSection`, which already emits the
 *          history row inside the same transaction.
 *
 * For (1) and (2) we replicate the script's audit-producing code path
 * inline (mirroring the existing `report-section-audit-trail.test.ts`
 * approach) and add a source-level guard that asserts the script file
 * actually still contains the editor/source attribution constants — so a
 * refactor that drops the audit pairing on the real script is caught.
 * For (3) we exercise `upsertReportSection` with the exact attribution
 * the script passes.
 */

import { sql } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import { db } from "../server/db";
import {
  reportSections,
  reportSectionHistory,
} from "../shared/schema";
import {
  upsertReportSection,
  getReportSectionHistory,
} from "../server/storage/reportStorage";
import { eq } from "drizzle-orm";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

const TAG = `script-audit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CLIENT_ID = `client-${TAG}`;
const ACTOR_ID = `actor-${TAG}`;
const DEMO_REPORT_ID = `report-demo-${TAG}`;
const DEMO_SECTION_ID = `section-demo-${TAG}`;
const CLEANUP_REPORT_ID = `report-cleanup-${TAG}`;
const FIXTURE_REPORT_ID = `report-fix-${TAG}`;
const ALL_REPORT_IDS = [DEMO_REPORT_ID, CLEANUP_REPORT_ID, FIXTURE_REPORT_ID];

async function setup(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, first_name, last_name)
    VALUES (${ACTOR_ID}, ${`${ACTOR_ID}@example.com`}, 'Script', 'Audit')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO clients (id, firm_name)
    VALUES (${CLIENT_ID}, ${`Script Audit ${TAG}`})
    ON CONFLICT (id) DO NOTHING
  `);
  const months = ["2026-01", "2026-02", "2026-03"];
  for (let i = 0; i < ALL_REPORT_IDS.length; i++) {
    await db.execute(sql`
      INSERT INTO reports (id, client_id, report_month, status, created_by)
      VALUES (${ALL_REPORT_IDS[i]}, ${CLIENT_ID}, ${months[i]}, 'draft', ${ACTOR_ID})
      ON CONFLICT (id) DO NOTHING
    `);
  }
}

async function cleanup(): Promise<void> {
  for (const id of ALL_REPORT_IDS) {
    await db.execute(sql`DELETE FROM report_section_history WHERE report_id = ${id}`);
    await db.execute(sql`DELETE FROM report_sections WHERE report_id = ${id}`);
    await db.execute(sql`DELETE FROM reports WHERE id = ${id}`);
  }
  await db.execute(sql`DELETE FROM clients WHERE id = ${CLIENT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${ACTOR_ID}`);
}

function readScript(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf-8");
}

// -----------------------------------------------------------------------------
// (1) scripts/import-demo-data.ts
// -----------------------------------------------------------------------------
async function testImportDemoData(): Promise<void> {
  const src = readScript("scripts/import-demo-data.ts");
  assert(
    /DEMO_IMPORT_EDITOR\s*=\s*"script:import-demo-data"/.test(src),
    "import-demo-data.ts still declares editor constant",
  );
  assert(
    /DEMO_IMPORT_SOURCE\s*=\s*"migration_seed"/.test(src),
    "import-demo-data.ts still declares migration_seed source",
  );
  assert(
    /db\.insert\(reportSectionHistory\)\.values/.test(src),
    "import-demo-data.ts still pairs writes with report_section_history insert",
  );

  // Replicate the script's per-section block for an INSERT path.
  const EDITOR = "script:import-demo-data";
  const SOURCE = "migration_seed" as const;
  const section = {
    id: DEMO_SECTION_ID,
    reportId: DEMO_REPORT_ID,
    sectionKey: "intake",
    data: { totalCases: 11 },
  };

  async function runSectionWrite(sectionRow: typeof section) {
    const existing = await db.select().from(reportSections).where(eq(reportSections.id, sectionRow.id));
    const previousData = existing.length > 0 ? existing[0].data : null;
    const now = new Date();
    const withAttribution = {
      ...sectionRow,
      lastEditedBy: EDITOR,
      lastEditSource: SOURCE,
      lastEditAt: now,
    } as any;
    if (existing.length > 0) {
      await db.update(reportSections).set(withAttribution).where(eq(reportSections.id, sectionRow.id));
    } else {
      await db.insert(reportSections).values(withAttribution);
    }
    await db.insert(reportSectionHistory).values({
      reportSectionId: sectionRow.id,
      reportId: sectionRow.reportId,
      sectionKey: sectionRow.sectionKey,
      previousData,
      newData: sectionRow.data,
      dataChanged: JSON.stringify(previousData) !== JSON.stringify(sectionRow.data),
      editedBy: EDITOR,
      editSource: SOURCE,
      webhookImportLogId: null,
    });
  }

  await runSectionWrite(section);

  let history = await getReportSectionHistory(DEMO_REPORT_ID, "intake");
  assert(history.length === 1, `insert path: expected 1 history row, got ${history.length}`);
  const insertRow = history[0];
  assert(insertRow.editedBy === EDITOR, "insert path: editedBy attributed to script");
  assert(insertRow.editSource === SOURCE, "insert path: editSource = migration_seed");
  assert(insertRow.previousData === null, "insert path: previousData null on first write");
  assert((insertRow.newData as any).totalCases === 11, "insert path: newData snapshot recorded");
  assert(insertRow.dataChanged === true, "insert path: dataChanged true (null vs new)");

  const [liveAfterInsert] = await db.select().from(reportSections).where(eq(reportSections.id, DEMO_SECTION_ID));
  assert(liveAfterInsert.lastEditedBy === EDITOR, "insert path: live row last_edited_by stamped");
  assert(liveAfterInsert.lastEditSource === SOURCE, "insert path: live row last_edit_source stamped");

  // UPDATE path — re-run with changed data.
  await runSectionWrite({ ...section, data: { totalCases: 22 } });

  history = await getReportSectionHistory(DEMO_REPORT_ID, "intake");
  assert(history.length === 2, `update path: expected 2 history rows, got ${history.length}`);
  const updateRow = history[0];
  assert(updateRow.editedBy === EDITOR, "update path: editedBy attributed to script");
  assert(updateRow.editSource === SOURCE, "update path: editSource = migration_seed");
  assert((updateRow.previousData as any).totalCases === 11, "update path: previousData captured");
  assert((updateRow.newData as any).totalCases === 22, "update path: newData captured");
  assert(updateRow.dataChanged === true, "update path: dataChanged true on real change");
}

// -----------------------------------------------------------------------------
// (2) scripts/cleanup-ghost-gbp-locations.ts
// -----------------------------------------------------------------------------
async function testCleanupGhostGbp(): Promise<void> {
  const src = readScript("scripts/cleanup-ghost-gbp-locations.ts");
  assert(
    /CLEANUP_EDITOR\s*=\s*"script:cleanup-ghost-gbp-locations"/.test(src),
    "cleanup-ghost-gbp-locations.ts still declares editor constant",
  );
  assert(
    /CLEANUP_SOURCE\s*=\s*"system"/.test(src),
    "cleanup-ghost-gbp-locations.ts still declares system source",
  );
  assert(
    /db\.insert\(reportSectionHistory\)\.values/.test(src),
    "cleanup-ghost-gbp-locations.ts still pairs UPDATE with report_section_history insert",
  );

  const EDITOR = "script:cleanup-ghost-gbp-locations";
  const SOURCE = "system" as const;

  // Seed an existing marketing section with one keep + one ghost.
  const beforeData = {
    gbp: {
      locations: [
        { id: "real-loc-id", name: "Real" },
        { id: "ghost-loc-id", name: "Ghost" },
      ],
    },
  };
  const [seeded] = await db
    .insert(reportSections)
    .values({
      reportId: CLEANUP_REPORT_ID,
      sectionKey: "marketing",
      data: beforeData,
    } as any)
    .returning();

  // Replicate the script's apply-branch.
  const cleanedData = {
    gbp: { locations: [{ id: "real-loc-id", name: "Real" }] },
  };
  const now = new Date();
  await db
    .update(reportSections)
    .set({
      data: cleanedData,
      updatedAt: now,
      lastEditedBy: EDITOR,
      lastEditSource: SOURCE,
      lastEditAt: now,
    } as any)
    .where(eq(reportSections.id, seeded.id));
  await db.insert(reportSectionHistory).values({
    reportSectionId: seeded.id,
    reportId: CLEANUP_REPORT_ID,
    sectionKey: "marketing",
    previousData: beforeData,
    newData: cleanedData,
    dataChanged: true,
    editedBy: EDITOR,
    editSource: SOURCE,
    webhookImportLogId: null,
  });

  const history = await getReportSectionHistory(CLEANUP_REPORT_ID, "marketing");
  assert(history.length === 1, `cleanup: expected 1 history row, got ${history.length}`);
  const row = history[0];
  assert(row.editedBy === EDITOR, "cleanup: editedBy attributed to script");
  assert(row.editSource === SOURCE, "cleanup: editSource = system");
  assert(
    (row.previousData as any).gbp.locations.length === 2,
    "cleanup: previousData captured pre-cleanup array",
  );
  assert(
    (row.newData as any).gbp.locations.length === 1,
    "cleanup: newData captured post-cleanup array",
  );
  assert(row.dataChanged === true, "cleanup: dataChanged true on ghost removal");

  const [live] = await db.select().from(reportSections).where(eq(reportSections.id, seeded.id));
  assert(live.lastEditedBy === EDITOR, "cleanup: live row last_edited_by stamped");
  assert(live.lastEditSource === SOURCE, "cleanup: live row last_edit_source stamped");
}

// -----------------------------------------------------------------------------
// (3) scripts/verification-fixtures.ts
// -----------------------------------------------------------------------------
async function testVerificationFixtures(): Promise<void> {
  const src = readScript("scripts/verification-fixtures.ts");
  assert(
    /editor:\s*"script:verification-fixtures"/.test(src),
    "verification-fixtures.ts still passes editor='script:verification-fixtures'",
  );
  assert(
    /source:\s*"migration_seed"/.test(src),
    "verification-fixtures.ts still passes source='migration_seed'",
  );
  assert(
    /upsertReportSection\s*\(/.test(src),
    "verification-fixtures.ts still routes through upsertReportSection",
  );

  // Drive the exact call the script's seedReport makes (INSERT path).
  const inserted = await upsertReportSection(
    {
      reportId: FIXTURE_REPORT_ID,
      sectionKey: "intake",
      data: { totalLeads: 45, consultsBooked: 30 },
    },
    { editor: "script:verification-fixtures", source: "migration_seed" },
  );
  assert(inserted.lastEditedBy === "script:verification-fixtures", "fixtures insert: live editor stamped");
  assert(inserted.lastEditSource === "migration_seed", "fixtures insert: live source stamped");

  let history = await getReportSectionHistory(FIXTURE_REPORT_ID, "intake");
  assert(history.length === 1, `fixtures insert: expected 1 history row, got ${history.length}`);
  assert(history[0].editedBy === "script:verification-fixtures", "fixtures insert: history editor matches");
  assert(history[0].editSource === "migration_seed", "fixtures insert: history source matches");
  assert(history[0].previousData === null, "fixtures insert: previousData null on first write");
  assert((history[0].newData as any).totalLeads === 45, "fixtures insert: newData snapshot recorded");
  assert(history[0].dataChanged === true, "fixtures insert: dataChanged true on first write");

  // UPDATE path — re-running the same seed call with changed data.
  await upsertReportSection(
    {
      reportId: FIXTURE_REPORT_ID,
      sectionKey: "intake",
      data: { totalLeads: 99, consultsBooked: 70 },
    },
    { editor: "script:verification-fixtures", source: "migration_seed" },
  );
  history = await getReportSectionHistory(FIXTURE_REPORT_ID, "intake");
  assert(history.length === 2, `fixtures update: expected 2 history rows, got ${history.length}`);
  const upd = history[0];
  assert(upd.editedBy === "script:verification-fixtures", "fixtures update: history editor matches");
  assert(upd.editSource === "migration_seed", "fixtures update: history source matches");
  assert((upd.previousData as any).totalLeads === 45, "fixtures update: previousData captured");
  assert((upd.newData as any).totalLeads === 99, "fixtures update: newData captured");
  assert(upd.dataChanged === true, "fixtures update: dataChanged true on real change");
}

async function main(): Promise<void> {
  await cleanup();
  await setup();
  try {
    await testImportDemoData();
    await testCleanupGhostGbp();
    await testVerificationFixtures();
    console.log("[script-level-audit-trail] PASS");
  } finally {
    await cleanup();
  }
}

// Test teardown in server/db.ts drains the pg pools in test mode (Task #2084), so the
// process exits on its own once work settles — no manual process.exit(), so a leaked
// handle now surfaces as a real hang instead of being masked by a forced exit.
await main();
