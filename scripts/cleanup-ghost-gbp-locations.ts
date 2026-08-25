/**
 * One-shot cleanup for ghost GBP location rows in marketing report sections.
 *
 * Background:
 *   The PDF import path historically stamped a fresh crypto.randomUUID() onto
 *   every imported GBP location row, never matching against the client's
 *   command-panel locations. As a result, every imported PDF appended ghost
 *   rows whose `id` does not exist in `client_locations`. Reps then manually
 *   updated the *real* (command-panel-keyed) rows with correct numbers, so
 *   the ghosts are now noise and should simply be removed — no merging.
 *
 * Behavior:
 *   For every report_sections row where section_key='marketing' and
 *   data->'gbp'->'locations' is a non-empty array, classify each row:
 *     - KEEP        — id is present in this client's client_locations
 *     - DROP-GHOST  — id is NOT in this client's client_locations
 *
 * Default mode is dry-run: print the per-report plan and the summary, do
 * not write. `--apply` writes the cleaned array back to report_sections.data
 * after first dumping the original gbp.locations array to
 * `tmp/ghost-cleanup-backup/<report_id>.json`.
 *
 * Optional flags:
 *   --client <client_id>    Limit to one client.
 *   --report <report_id>    Limit to one report.
 *   --apply                 Actually mutate the database.
 *   --quiet                 Suppress per-report KEEP/DROP detail.
 *
 * Idempotent: a re-run with --apply after a clean run produces a "0 changes"
 * plan because every remaining row's id will be in client_locations.
 */

// NOTE: DB-touching imports are deferred into `main()` so importing
// `planReportCleanup` from a unit test does not boot the server/db pool
// (which starts setInterval timers that keep node processes alive).
import * as fs from "fs";
import * as path from "path";

type Args = {
  apply: boolean;
  quiet: boolean;
  clientId?: string;
  reportId?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--client") out.clientId = argv[++i];
    else if (a === "--report") out.reportId = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(__filename + " [--apply] [--quiet] [--client <id>] [--report <id>]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

type GbpLoc = { id?: string; name?: string; [k: string]: any };

type RowPlan = {
  index: number;
  id: string;
  name: string;
  action: "KEEP" | "DROP-GHOST";
};

type ReportPlan = {
  reportId: string;
  clientId: string;
  reportMonth: string;
  rows: RowPlan[];
  cleaned: GbpLoc[];
  changed: boolean;
};

export function planReportCleanup(
  reportId: string,
  clientId: string,
  reportMonth: string,
  locations: GbpLoc[],
  commandPanelIds: Set<string>,
): ReportPlan {
  const rows: RowPlan[] = [];
  const cleaned: GbpLoc[] = [];
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i] || {};
    const id = String(loc.id ?? "");
    const name = String(loc.name ?? "");
    const action: RowPlan["action"] = id && commandPanelIds.has(id) ? "KEEP" : "DROP-GHOST";
    rows.push({ index: i, id, name, action });
    if (action === "KEEP") cleaned.push(loc);
  }
  const changed = cleaned.length !== locations.length;
  return { reportId, clientId, reportMonth, rows, cleaned, changed };
}

async function main() {
  const { db } = await import("../server/db");
  const { reportSections, reportSectionHistory, reports, clientLocations } = await import("@shared/schema");
  const { eq, and } = await import("drizzle-orm");

  const CLEANUP_EDITOR = "script:cleanup-ghost-gbp-locations";
  const CLEANUP_SOURCE = "system" as const;

  const args = parseArgs(process.argv);
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`[ghost-gbp-cleanup] mode=${mode}${args.clientId ? ` client=${args.clientId}` : ""}${args.reportId ? ` report=${args.reportId}` : ""}`);

  // Pull all marketing sections that contain a non-empty gbp.locations array,
  // joined to their report so we know the client_id.
  const conditions: any[] = [eq(reportSections.sectionKey, "marketing")];
  if (args.reportId) conditions.push(eq(reportSections.reportId, args.reportId));

  const sectionRows = await db
    .select({
      sectionId: reportSections.id,
      reportId: reportSections.reportId,
      data: reportSections.data,
      clientId: reports.clientId,
      reportMonth: reports.reportMonth,
    })
    .from(reportSections)
    .innerJoin(reports, eq(reports.id, reportSections.reportId))
    .where(and(...conditions));

  // Cache command-panel ids per client to avoid N+1 fetches.
  const commandPanelByClient = new Map<string, Set<string>>();
  async function getCommandPanelIds(clientId: string): Promise<Set<string>> {
    let s = commandPanelByClient.get(clientId);
    if (s) return s;
    const rows = await db
      .select({ id: clientLocations.id })
      .from(clientLocations)
      .where(eq(clientLocations.clientId, clientId));
    s = new Set(rows.map(r => r.id));
    commandPanelByClient.set(clientId, s);
    return s;
  }

  let reportsScanned = 0;
  let reportsChanged = 0;
  let totalKept = 0;
  let totalDropped = 0;
  const changedPlans: ReportPlan[] = [];

  for (const row of sectionRows) {
    if (args.clientId && row.clientId !== args.clientId) continue;
    const data: any = row.data ?? {};
    const locations: GbpLoc[] = Array.isArray(data?.gbp?.locations) ? data.gbp.locations : [];
    if (locations.length === 0) continue;

    reportsScanned++;
    const cpIds = await getCommandPanelIds(row.clientId);
    const plan = planReportCleanup(row.reportId, row.clientId, row.reportMonth, locations, cpIds);

    const dropped = plan.rows.filter(r => r.action === "DROP-GHOST").length;
    const kept = plan.rows.length - dropped;
    totalKept += kept;
    totalDropped += dropped;

    if (!plan.changed) continue;
    reportsChanged++;
    changedPlans.push(plan);

    if (!args.quiet) {
      console.log(`\n  client=${plan.clientId} report=${plan.reportId} month=${plan.reportMonth}`);
      console.log(`    before=${plan.rows.length} after=${plan.cleaned.length} dropped=${dropped}`);
      for (const r of plan.rows) {
        if (r.action === "DROP-GHOST") {
          console.log(`    DROP-GHOST  id=${r.id || "(none)"}  name=${JSON.stringify(r.name)}`);
        }
      }
    }

    if (args.apply) {
      const backupDir = path.resolve(process.cwd(), "tmp/ghost-cleanup-backup");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `${plan.reportId}.json`);
      fs.writeFileSync(backupPath, JSON.stringify({
        reportId: plan.reportId,
        clientId: plan.clientId,
        reportMonth: plan.reportMonth,
        capturedAt: new Date().toISOString(),
        original: locations,
      }, null, 2));

      const newData = { ...data, gbp: { ...(data.gbp || {}), locations: plan.cleaned } };
      // NOTE: We bypass `upsertReportSection` here because this cleanup is a
      // surgical JSONB patch on an already-existing row keyed by `sectionId`,
      // not a logical "(reportId, sectionKey) upsert" — the helper would re-key
      // by (reportId, sectionKey) and re-derive the row. We still pair the
      // raw UPDATE with a `report_section_history` seed row so the audit trail
      // captures the editor (`script:cleanup-ghost-gbp-locations`) and a
      // `system` source for every mutated section.
      const now = new Date();
      await db
        .update(reportSections)
        .set({
          data: newData,
          updatedAt: now,
          lastEditedBy: CLEANUP_EDITOR,
          lastEditSource: CLEANUP_SOURCE,
          lastEditAt: now,
        })
        .where(eq(reportSections.id, row.sectionId));
      await db.insert(reportSectionHistory).values({
        reportSectionId: row.sectionId,
        reportId: row.reportId,
        sectionKey: "marketing",
        previousData: data,
        newData,
        dataChanged: true,
        editedBy: CLEANUP_EDITOR,
        editSource: CLEANUP_SOURCE,
        webhookImportLogId: null,
      });
    }
  }

  console.log(`\n[ghost-gbp-cleanup] summary`);
  console.log(`  mode=${mode}`);
  console.log(`  reports_scanned_with_locations=${reportsScanned}`);
  console.log(`  reports_with_ghosts=${reportsChanged}`);
  console.log(`  rows_kept=${totalKept}`);
  console.log(`  rows_dropped=${totalDropped}`);
  if (!args.apply && reportsChanged > 0) {
    console.log(`\n  Re-run with --apply to commit. Backups will be written to tmp/ghost-cleanup-backup/<report_id>.json`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
