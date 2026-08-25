/**
 * Task #831 / #1267 / #3769 — Cross-report cleanup of placeholder
 * commonIssues values.
 *
 * Background:
 *   Task #830 fixed the PDF parser so the literal placeholder text
 *   "Missing data source - There is no data source associated with this
 *    component. See details" is no longer written into
 *   report_sections.data.commonIssues. Task #831 cleared rows whose stored
 *   value was still the literal placeholder (or a whitespace/dash-only
 *   body). Task #1267 extended this cleanup to AI-rewritten placeholder
 *   findings ("🔴 **Issue:** Missing data source. …" blocks). Task #3769
 *   extended detection to placeholders with a trailing source-name artifact
 *   ("… See details Name_Clean (1): Ackah Law" — underscored, spaced, or
 *   collapsed) and moved the scan/clear core into
 *   `server/services/placeholderCommonIssuesCleanup.ts`, shared 1:1 with the
 *   `clear_placeholder_common_issues` CEO production action so the CLI and
 *   the action can never drift. This CLI remains for dev inspection —
 *   against the deployed database use the production action (dev can only
 *   read prod).
 *
 * Behavior:
 *   - Scans every report_sections row with sectionKey "intake"/"sales" and a
 *     non-empty data.commonIssues string.
 *   - Eligible when the ENTIRE value is (a) the literal placeholder family
 *     (source-name tails included), (b) a blank/dashes/artifact-only body,
 *     (c) an AI-rewritten placeholder finding — Task #3901: including the
 *     junk-fabricated multi-block class (leading 'Missing data source' 🔴
 *     block + siblings hallucinated from swallowed dashboard junk) and
 *     mid-text Name_Clean remediation variants — or (d) the raw literal
 *     placeholder with a swallowed-junk tail. Mixed real findings are left
 *     untouched.
 *   - Default mode is dry-run: prints the affected rows.
 *   - With `--apply`, sets `data.commonIssues = ""` (other keys preserved),
 *     re-checking each row immediately before write.
 *   - Idempotent: re-running with --apply after the first apply finds
 *     nothing to clear and exits 0.
 *
 * Usage:
 *   npx tsx scripts/clear-placeholder-common-issues.ts          # dry run
 *   npx tsx scripts/clear-placeholder-common-issues.ts --apply  # write
 */

type Args = { apply: boolean };

const SCRIPT_USAGE =
  "scripts/clear-placeholder-common-issues.ts [--apply]";

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

function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

async function main() {
  const args = parseArgs(process.argv);

  const { db } = await import("../server/db");
  const { scanPlaceholderCommonIssues, clearPlaceholderCommonIssuesCandidates } =
    await import("../server/services/placeholderCommonIssuesCleanup");

  const scan = await scanPlaceholderCommonIssues(db);

  console.log(
    `[clear-placeholder-common-issues] Scanned ${scan.scanned} intake/sales section rows.`,
  );
  console.log(
    `  already empty: ${scan.alreadyEmpty}, has real content (skipped): ${scan.skippedRealContent}, eligible: ${scan.candidates.length}`,
  );
  console.log(
    `  by kind: literal=${scan.countsByKind.literal_placeholder}, blank=${scan.countsByKind.blank_body}, ai_rewritten=${scan.countsByKind.ai_rewritten_placeholder}, junk_fabricated=${scan.countsByKind.junk_fabricated_placeholder}, junk_tailed_literal=${scan.countsByKind.junk_tailed_literal}`,
  );

  if (scan.candidates.length === 0) {
    console.log(`[clear-placeholder-common-issues] Nothing to clear.`);
    process.exit(0);
  }

  for (const e of scan.candidates) {
    console.log(
      `  - report=${e.reportId} section=${e.sectionKey} row=${e.id} kind=${e.kind} value=${JSON.stringify(preview(e.current))}`,
    );
  }

  if (!args.apply) {
    console.log(
      `[clear-placeholder-common-issues] DRY RUN — re-run with --apply to clear ${scan.candidates.length} row(s).`,
    );
    process.exit(0);
  }

  const updated = await clearPlaceholderCommonIssuesCandidates(db, scan.candidates);

  console.log(
    `[clear-placeholder-common-issues] APPLIED — cleared commonIssues on ${updated} row(s).`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[clear-placeholder-common-issues] FAILED", err);
  process.exit(1);
});
