/**
 * Task #830 — One-shot data correction for Grace Legal Group.
 *
 * Background:
 *   The PDF parser previously stored the literal placeholder text
 *   "Missing data source - There is no data source associated with this
 *    component. See details" into report_sections.data.commonIssues for
 *   sales sections when the source PDF had no Sales Common Issues body.
 *   Operators reviewing the report saw the placeholder rendered as if it
 *   were a real finding. Task #830 fixes the parser; this script clears
 *   the already-stored bad value for Grace Legal Group's report
 *   `6564e809-3af0-4c7a-9732-3b7d1540209e` so the UI shows an empty
 *   commonIssues field after the fix lands.
 *
 * Behavior:
 *   - Default mode is dry-run: prints what would change.
 *   - With `--apply`, sets `data.commonIssues = ""` for the sales section
 *     of the target report. Other keys in `data` are preserved.
 *   - Idempotent: a re-run with --apply when commonIssues is already empty
 *     prints "no change" and exits 0.
 *
 * Usage:
 *   npx tsx scripts/clear-grace-legal-sales-common-issues.ts          # dry run
 *   npx tsx scripts/clear-grace-legal-sales-common-issues.ts --apply  # write
 */

const REPORT_ID = "6564e809-3af0-4c7a-9732-3b7d1540209e";
const SECTION_KEY = "sales";

type Args = { apply: boolean };

const SCRIPT_USAGE =
  "scripts/clear-grace-legal-sales-common-issues.ts [--apply]";

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log(SCRIPT_USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  // Defer DB imports so the script doesn't boot pools/timers when only
  // running --help or being inspected.
  const { db } = await import("../server/db");
  const { reportSections } = await import("@shared/schema");
  const { and, eq } = await import("drizzle-orm");
  const {
    isEmptySectionBody,
    isMissingDataSourcePlaceholder,
  } = await import("../server/services/pdfImportParser");

  const rows = await db
    .select({
      id: reportSections.id,
      reportId: reportSections.reportId,
      sectionKey: reportSections.sectionKey,
      data: reportSections.data,
    })
    .from(reportSections)
    .where(
      and(
        eq(reportSections.reportId, REPORT_ID),
        eq(reportSections.sectionKey, SECTION_KEY),
      ),
    );

  if (rows.length === 0) {
    console.log(
      `[clear-grace-legal] No sales section row found for report ${REPORT_ID}. Nothing to do.`,
    );
    process.exit(0);
  }
  if (rows.length > 1) {
    console.error(
      `[clear-grace-legal] Expected 1 sales section row, found ${rows.length}. Aborting.`,
    );
    process.exit(3);
  }

  const row = rows[0];
  const data = (row.data ?? {}) as Record<string, unknown>;
  const current =
    typeof data.commonIssues === "string" ? (data.commonIssues as string) : "";

  console.log(`[clear-grace-legal] Report:       ${REPORT_ID}`);
  console.log(`[clear-grace-legal] Section row:  ${row.id}`);
  console.log(`[clear-grace-legal] Current value (${current.length} chars):`);
  console.log(`  ${JSON.stringify(current)}`);

  if (current === "") {
    console.log(`[clear-grace-legal] Already empty. No change required.`);
    process.exit(0);
  }

  const wasPlaceholder = isMissingDataSourcePlaceholder(current);
  const wasEmptyBody = isEmptySectionBody(current);
  console.log(
    `[clear-grace-legal] Detected placeholder: ${wasPlaceholder}, empty body: ${wasEmptyBody}`,
  );

  if (!args.apply) {
    console.log(
      `[clear-grace-legal] DRY RUN — re-run with --apply to clear data.commonIssues.`,
    );
    process.exit(0);
  }

  const nextData = { ...data, commonIssues: "" };
  await db
    .update(reportSections)
    .set({ data: nextData })
    .where(eq(reportSections.id, row.id));

  console.log(`[clear-grace-legal] APPLIED — data.commonIssues set to "".`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[clear-grace-legal] FAILED", err);
  process.exit(1);
});
