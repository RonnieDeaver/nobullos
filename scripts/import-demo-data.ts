import { db } from "../server/db";
import { clients, clientLocations, clientDataAccess, reports, reportSections, reportSectionHistory, ceoPulses } from "../shared/schema";
import { eq } from "drizzle-orm";
import * as fs from "fs";

const DEMO_IMPORT_EDITOR = "script:import-demo-data";
const DEMO_IMPORT_SOURCE = "migration_seed" as const;

// Convert date strings back to Date objects
function convertDates(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(obj)) {
    return new Date(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(convertDates);
  }
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = convertDates(obj[key]);
    }
    return result;
  }
  return obj;
}

async function importDemoData() {
  const inputPath = "scripts/demo-data-export.json";
  
  if (!fs.existsSync(inputPath)) {
    console.error(`Export file not found: ${inputPath}`);
    console.error("Run 'npx tsx scripts/export-demo-data.ts' first to generate the export.");
    process.exit(1);
  }

  console.log("Importing demo data into database...\n");
  
  const rawData = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
  const data = convertDates(rawData);
  console.log(`Export from: ${rawData.exportedAt}`);

  // Import in order of dependencies
  
  // 1. CEO Pulses first (no dependencies)
  console.log(`\nImporting ${data.ceoPulses?.length || 0} CEO pulses...`);
  for (const pulse of data.ceoPulses || []) {
    const existing = await db.select().from(ceoPulses).where(eq(ceoPulses.id, pulse.id));
    if (existing.length > 0) {
      await db.update(ceoPulses).set(pulse).where(eq(ceoPulses.id, pulse.id));
      console.log(`  Updated: ${pulse.monthKey}`);
    } else {
      await db.insert(ceoPulses).values(pulse);
      console.log(`  Inserted: ${pulse.monthKey}`);
    }
  }

  // 2. Clients
  console.log(`\nImporting ${data.clients?.length || 0} clients...`);
  for (const client of data.clients || []) {
    const existing = await db.select().from(clients).where(eq(clients.id, client.id));
    if (existing.length > 0) {
      await db.update(clients).set(client).where(eq(clients.id, client.id));
      console.log(`  Updated: ${client.firmName}`);
    } else {
      await db.insert(clients).values(client);
      console.log(`  Inserted: ${client.firmName}`);
    }
  }

  // 3. Client Locations
  console.log(`\nImporting ${data.clientLocations?.length || 0} client locations...`);
  for (const loc of data.clientLocations || []) {
    const existing = await db.select().from(clientLocations).where(eq(clientLocations.id, loc.id));
    if (existing.length > 0) {
      await db.update(clientLocations).set(loc).where(eq(clientLocations.id, loc.id));
      console.log(`  Updated: ${loc.name}`);
    } else {
      await db.insert(clientLocations).values(loc);
      console.log(`  Inserted: ${loc.name}`);
    }
  }

  // 4. Client Data Access
  console.log(`\nImporting ${data.clientDataAccess?.length || 0} data access records...`);
  for (const access of data.clientDataAccess || []) {
    const existing = await db.select().from(clientDataAccess).where(eq(clientDataAccess.id, access.id));
    if (existing.length > 0) {
      await db.update(clientDataAccess).set(access).where(eq(clientDataAccess.id, access.id));
      console.log(`  Updated: ${access.category}`);
    } else {
      await db.insert(clientDataAccess).values(access);
      console.log(`  Inserted: ${access.category}`);
    }
  }

  // 5. Reports
  console.log(`\nImporting ${data.reports?.length || 0} reports...`);
  for (const report of data.reports || []) {
    const existing = await db.select().from(reports).where(eq(reports.id, report.id));
    if (existing.length > 0) {
      await db.update(reports).set(report).where(eq(reports.id, report.id));
      console.log(`  Updated: ${report.reportMonth}`);
    } else {
      await db.insert(reports).values(report);
      console.log(`  Inserted: ${report.reportMonth}`);
    }
  }

  // 6. Report Sections
  // NOTE: We bypass `upsertReportSection` here because demo-data restore must
  // preserve the exact `id` values from the export file (the helper resolves
  // rows by (reportId, sectionKey) and would not honor a caller-supplied id).
  // To keep the audit trail intact we still seed a paired `report_section_history`
  // row for every write, attributed to this script as a `migration_seed` source.
  console.log(`\nImporting ${data.reportSections?.length || 0} report sections...`);
  for (const section of data.reportSections || []) {
    const existing = await db.select().from(reportSections).where(eq(reportSections.id, section.id));
    const previousData = existing.length > 0 ? existing[0].data : null;
    const now = new Date();
    const sectionWithAttribution = {
      ...section,
      lastEditedBy: DEMO_IMPORT_EDITOR,
      lastEditSource: DEMO_IMPORT_SOURCE,
      lastEditAt: now,
    };
    if (existing.length > 0) {
      await db.update(reportSections).set(sectionWithAttribution).where(eq(reportSections.id, section.id));
      console.log(`  Updated: ${section.sectionKey}`);
    } else {
      await db.insert(reportSections).values(sectionWithAttribution);
      console.log(`  Inserted: ${section.sectionKey}`);
    }
    await db.insert(reportSectionHistory).values({
      reportSectionId: section.id,
      reportId: section.reportId,
      sectionKey: section.sectionKey,
      previousData,
      newData: section.data,
      dataChanged: JSON.stringify(previousData) !== JSON.stringify(section.data),
      editedBy: DEMO_IMPORT_EDITOR,
      editSource: DEMO_IMPORT_SOURCE,
      webhookImportLogId: null,
    });
  }

  console.log("\nImport complete!");
}

importDemoData().catch(err => {
  console.error("Import failed:", err);
  process.exit(1);
});
