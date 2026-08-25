import { db } from "../server/db";
import { clients, clientLocations, clientDataAccess, reports, reportSections, ceoPulses } from "../shared/schema";
import { eq } from "drizzle-orm";
import * as fs from "fs";

async function exportDemoData() {
  console.log("Exporting demo data from development database...\n");

  // Find demo client
  const allClients = await db.select().from(clients);
  const demoClient = allClients.find(c => c.isDemo === true);
  
  if (!demoClient) {
    console.error("No demo client found (isDemo = true). Please mark a client as demo first.");
    process.exit(1);
  }
  
  console.log(`Found demo client: ${demoClient.firmName} (${demoClient.id})`);

  // Get related data
  const locations = await db.select().from(clientLocations).where(eq(clientLocations.clientId, demoClient.id));
  console.log(`  - ${locations.length} locations`);
  
  const dataAccess = await db.select().from(clientDataAccess).where(eq(clientDataAccess.clientId, demoClient.id));
  console.log(`  - ${dataAccess.length} data access records`);
  
  const clientReports = await db.select().from(reports).where(eq(reports.clientId, demoClient.id));
  console.log(`  - ${clientReports.length} reports`);
  
  // Get all sections for these reports
  const allSections: any[] = [];
  for (const report of clientReports) {
    const sections = await db.select().from(reportSections).where(eq(reportSections.reportId, report.id));
    allSections.push(...sections);
  }
  console.log(`  - ${allSections.length} report sections`);
  
  // Get CEO pulses referenced by reports
  const pulseIds = new Set(clientReports.map(r => r.ceoPulseId).filter(Boolean));
  const pulses: any[] = [];
  for (const pulseId of pulseIds) {
    const pulse = await db.select().from(ceoPulses).where(eq(ceoPulses.id, pulseId as string));
    if (pulse.length > 0) pulses.push(pulse[0]);
  }
  
  // Also get any pulses by month that reports might use
  const months = new Set(clientReports.map(r => r.reportMonth));
  for (const month of months) {
    const monthPulse = await db.select().from(ceoPulses).where(eq(ceoPulses.monthKey, month));
    if (monthPulse.length > 0 && !pulses.find(p => p.id === monthPulse[0].id)) {
      pulses.push(monthPulse[0]);
    }
  }
  console.log(`  - ${pulses.length} CEO pulses`);

  // Build export object
  const exportData = {
    exportedAt: new Date().toISOString(),
    version: 1,
    clients: [demoClient],
    clientLocations: locations,
    clientDataAccess: dataAccess,
    reports: clientReports,
    reportSections: allSections,
    ceoPulses: pulses,
  };

  // Write to file
  const outputPath = "scripts/demo-data-export.json";
  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
  console.log(`\nExported to ${outputPath}`);
  console.log("Run 'npx tsx scripts/import-demo-data.ts' in production to import this data.");
}

exportDemoData().catch(err => {
  console.error("Export failed:", err);
  process.exit(1);
});
