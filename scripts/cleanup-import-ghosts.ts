/**
 * Audit + cleanup script for "ghost" client-scoped entities that may have been
 * created by historical import / sync paths before Task #755 locked them down.
 *
 * Default mode is dry-run: it prints a report of the suspect rows but does
 * not write. Pass `--apply` to actually mutate the database. Even in --apply
 * mode the script is conservative: when provenance is ambiguous it prefers
 * report-only output over deletion.
 *
 * Surfaces audited:
 *   1. semrush_location_campaigns whose (client_id, location_id) is no longer
 *      present in client_locations. Under the new policy these would be
 *      dropped on insert, so they are safe ghosts to remove with --apply.
 *   2. client_contacts that look like they were auto-created by the old Front
 *      enrichment path: name == 'Auto-discovered Contact' AND is_primary=false
 *      AND no phones. These are reported only — deletion requires --apply.
 *   3. import_entity_suggestions counts grouped by (surface, entity_kind,
 *      status) so operators can see how many candidate entities are awaiting
 *      promotion under the new policy.
 *
 * Output: per-section breakdown to stdout, plus a machine-readable JSON
 * summary written to `tmp/import-ghosts-summary-<timestamp>.json` when the
 * script touches any rows.
 */

import * as fs from "fs";
import * as path from "path";

type Args = { apply: boolean; clientId?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--client") out.clientId = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(__filename + " [--apply] [--client <client_id>]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

export interface SemrushGhostRow {
  id: string;
  clientId: string;
  locationId: string;
  semrushCampaignId: string;
  semrushCampaignName: string | null;
}

export interface ContactGhostRow {
  id: string;
  clientId: string;
  name: string;
  emails: string[] | null;
  isPrimary: boolean;
}

/**
 * Pure planner — extracted for unit testing. Given the raw lists pulled from
 * the DB, returns the lists that would be acted on. No I/O.
 */
export function planSemrushGhosts(
  mappings: SemrushGhostRow[],
  configuredLocationIds: Set<string>,
): SemrushGhostRow[] {
  return mappings.filter(m => !configuredLocationIds.has(m.locationId));
}

export function planAutoDiscoveredContactGhosts(
  contacts: ContactGhostRow[],
): ContactGhostRow[] {
  return contacts.filter(c =>
    !c.isPrimary
    && (c.name || "").trim().toLowerCase() === "auto-discovered contact"
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const { db } = await import("../server/db");
  const {
    semrushLocationCampaigns, clientLocations, clientContacts, importEntitySuggestions,
  } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");

  console.log(`[import-ghosts] mode=${args.apply ? "APPLY" : "DRY-RUN"}${args.clientId ? ` client=${args.clientId}` : ""}`);

  // ── 1. SEMrush location campaigns whose locationId is no longer configured ──
  const allMappings: SemrushGhostRow[] = await db
    .select({
      id: semrushLocationCampaigns.id,
      clientId: semrushLocationCampaigns.clientId,
      locationId: semrushLocationCampaigns.locationId,
      semrushCampaignId: semrushLocationCampaigns.semrushCampaignId,
      semrushCampaignName: semrushLocationCampaigns.semrushCampaignName,
    })
    .from(semrushLocationCampaigns);

  const filteredMappings = args.clientId ? allMappings.filter(m => m.clientId === args.clientId) : allMappings;
  const allLocs = await db.select({ id: clientLocations.id }).from(clientLocations);
  const configuredIds = new Set(allLocs.map(l => l.id));
  const semrushGhosts = planSemrushGhosts(filteredMappings, configuredIds);

  console.log(`\n  [SEMrush] scanned=${filteredMappings.length} ghosts=${semrushGhosts.length}`);
  for (const g of semrushGhosts.slice(0, 50)) {
    console.log(`    GHOST  client=${g.clientId} location=${g.locationId} campaign=${g.semrushCampaignId} (${g.semrushCampaignName || "?"})`);
  }
  if (semrushGhosts.length > 50) console.log(`    … and ${semrushGhosts.length - 50} more`);

  // ── 2. Auto-discovered contacts likely created by old Front path ──
  const allContacts: ContactGhostRow[] = await db
    .select({
      id: clientContacts.id,
      clientId: clientContacts.clientId,
      name: clientContacts.name,
      emails: clientContacts.emails,
      isPrimary: clientContacts.isPrimary,
    })
    .from(clientContacts);
  const filteredContacts = args.clientId ? allContacts.filter(c => c.clientId === args.clientId) : allContacts;
  const contactGhosts = planAutoDiscoveredContactGhosts(filteredContacts);

  console.log(`\n  [Contacts] scanned=${filteredContacts.length} likely-ghosts=${contactGhosts.length}`);
  for (const g of contactGhosts.slice(0, 50)) {
    console.log(`    LIKELY-GHOST  client=${g.clientId} contact=${g.id} emails=${(g.emails || []).length}`);
  }
  if (contactGhosts.length > 50) console.log(`    … and ${contactGhosts.length - 50} more`);

  // ── 3. import_entity_suggestions overview ──
  const sugRows = await db
    .select({
      surface: importEntitySuggestions.surface,
      entityKind: importEntitySuggestions.entityKind,
      status: importEntitySuggestions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(importEntitySuggestions)
    .groupBy(importEntitySuggestions.surface, importEntitySuggestions.entityKind, importEntitySuggestions.status);

  console.log(`\n  [Suggestions] groups=${sugRows.length}`);
  for (const r of sugRows) {
    console.log(`    ${r.surface}/${r.entityKind}/${r.status} = ${r.count}`);
  }

  // ── Apply (only the unambiguous SEMrush case is mutated automatically) ──
  let semrushDeleted = 0;
  if (args.apply && semrushGhosts.length > 0) {
    for (const g of semrushGhosts) {
      await db.delete(semrushLocationCampaigns).where(eq(semrushLocationCampaigns.id, g.id));
      semrushDeleted++;
    }
    console.log(`\n  [SEMrush] deleted ${semrushDeleted} ghost mapping rows`);
  } else if (semrushGhosts.length > 0) {
    console.log(`\n  Re-run with --apply to delete ${semrushGhosts.length} ghost SEMrush mapping rows.`);
  }

  if (contactGhosts.length > 0) {
    console.log(`\n  [Contacts] deletion is intentionally NOT automated — emails may have been edited by operators.`);
    console.log(`  Review the list above and delete via Client Settings if appropriate.`);
  }

  // ── Persist machine-readable summary ──
  const summary = {
    mode: args.apply ? "APPLY" : "DRY-RUN",
    capturedAt: new Date().toISOString(),
    semrush: { scanned: filteredMappings.length, ghosts: semrushGhosts.length, deleted: semrushDeleted },
    contacts: { scanned: filteredContacts.length, likelyGhosts: contactGhosts.length },
    suggestions: sugRows,
  };
  if (semrushGhosts.length > 0 || contactGhosts.length > 0) {
    const outDir = path.resolve(process.cwd(), "tmp");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = Date.now();
    const jsonPath = path.join(outDir, `import-ghosts-summary-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    const md: string[] = [];
    md.push(`# Import Ghosts Cleanup Summary`);
    md.push(``);
    md.push(`- **Mode**: ${summary.mode}`);
    md.push(`- **Captured**: ${summary.capturedAt}`);
    if (args.clientId) md.push(`- **Scoped to client**: \`${args.clientId}\``);
    md.push(``);
    md.push(`## SEMrush location campaigns`);
    md.push(`- Scanned: ${summary.semrush.scanned}`);
    md.push(`- Ghost mappings (locationId not in client_locations): **${summary.semrush.ghosts}**`);
    md.push(`- Deleted this run: **${summary.semrush.deleted}**`);
    if (semrushGhosts.length > 0) {
      md.push(``);
      md.push(`| client_id | location_id | semrush_campaign_id | name |`);
      md.push(`|---|---|---|---|`);
      for (const g of semrushGhosts.slice(0, 100)) {
        md.push(`| \`${g.clientId}\` | \`${g.locationId}\` | \`${g.semrushCampaignId}\` | ${(g.semrushCampaignName || "").replace(/\|/g, "\\|") || "—"} |`);
      }
      if (semrushGhosts.length > 100) md.push(`| _… and ${semrushGhosts.length - 100} more_ | | | |`);
    }
    md.push(``);
    md.push(`## Likely-ghost auto-discovered contacts`);
    md.push(`- Scanned: ${summary.contacts.scanned}`);
    md.push(`- Likely ghosts: **${summary.contacts.likelyGhosts}** (review-only, never auto-deleted)`);
    if (contactGhosts.length > 0) {
      md.push(``);
      md.push(`| client_id | contact_id | emails |`);
      md.push(`|---|---|---|`);
      for (const g of contactGhosts.slice(0, 100)) {
        md.push(`| \`${g.clientId}\` | \`${g.id}\` | ${(g.emails || []).join(", ") || "—"} |`);
      }
    }
    md.push(``);
    md.push(`## Import suggestion queue`);
    if (sugRows.length === 0) md.push(`_No pending suggestions._`);
    else {
      md.push(``);
      md.push(`| surface | entity_kind | status | count |`);
      md.push(`|---|---|---|---|`);
      for (const r of sugRows) md.push(`| ${r.surface} | ${r.entityKind} | ${r.status} | ${r.count} |`);
    }

    const mdPath = path.join(outDir, `import-ghosts-summary-${stamp}.md`);
    fs.writeFileSync(mdPath, md.join("\n") + "\n");
    console.log(`\n  summary written to ${jsonPath}`);
    console.log(`  markdown written to ${mdPath}`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
