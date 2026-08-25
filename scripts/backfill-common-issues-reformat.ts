/**
 * Task #2390 — Bulk reformat Common Issues on ALL reports (CLI counterpart).
 *
 * Background:
 *   Task #2389 shipped the shared Common Issues formatter
 *   (`formatCommonIssuesContent` → 🔴 Issue / ↳ Impact / ➡️ Strategic Fix,
 *   with OCR-artifact cleanup and a deterministic never-throws fallback) so
 *   NEW imports are clean by default. Historical reports saved before that —
 *   and reports formatted by an earlier prompt version — still show raw OCR
 *   run-on text. Per CEO decision the new formatter is applied retroactively
 *   to the ENTIRE back catalog, re-running EVERY Intake/Sales Common Issues
 *   section through the AI (including already-formatted ones).
 *
 *   The real production write happens through the
 *   `reformat_common_issues_all_reports` CEO prod-action (dev can only READ
 *   prod). This CLI is the dev/inspection counterpart — dry-run by default —
 *   sharing the exact candidate-selection + processing core in
 *   `server/services/commonIssuesReformatBackfill.ts`.
 *
 * Behavior:
 *   - Dry-run by default. Pass `--apply` to write.
 *   - Idempotent / convergent: every processed section is stamped with the
 *     current backfill version; re-running after a clean apply finds nothing.
 *   - Empty / "missing data source" placeholder sections are left untouched.
 *   - Degrades safely: an individual AI failure falls back to the
 *     deterministic formatter; the run continues.
 *   - Worker DB pool tenancy: background/maintenance script, so all DB work
 *     goes through `workerDb` (never the request-scoped `api` pool).
 *
 * Flags:
 *   --apply            Actually write the sections. Default: dry-run.
 *   --client <id>      Restrict to a single client_id.
 *   --limit <n>        Max number of sections to process this run.
 *   --delay <ms>       Delay between AI calls. Default: 250.
 *   --quiet            Suppress per-section detail.
 *   --help             Print usage.
 *
 * Run:
 *   tsx scripts/backfill-common-issues-reformat.ts            # dry-run
 *   tsx scripts/backfill-common-issues-reformat.ts --apply    # write
 */

type Args = {
  apply: boolean;
  quiet: boolean;
  limit?: number;
  clientId?: string;
  delayMs: number;
};

const SCRIPT_USAGE =
  "tsx scripts/backfill-common-issues-reformat.ts [--apply] [--client <id>] [--limit <n>] [--delay <ms>] [--quiet]";

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, quiet: false, delayMs: 250 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--client") out.clientId = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--delay") out.delayMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(SCRIPT_USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (out.limit !== undefined && (!Number.isFinite(out.limit) || out.limit <= 0)) {
    console.error("--limit must be a positive number");
    process.exit(2);
  }
  if (!Number.isFinite(out.delayMs) || out.delayMs < 0) {
    console.error("--delay must be a non-negative number");
    process.exit(2);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);

  // Defer DB / service imports so importing this file (or running --help)
  // does not boot the server db pool / timers.
  const { workerDb: db } = await import("../server/db");
  const {
    findReformatCandidateSections,
    processReformatSection,
    COMMON_ISSUES_REFORMAT_BACKFILL_VERSION,
  } = await import("../server/services/commonIssuesReformatBackfill");

  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(
    `[backfill-common-issues-reformat] mode=${mode} version=${COMMON_ISSUES_REFORMAT_BACKFILL_VERSION} client=${args.clientId ?? "all"} limit=${args.limit ?? "none"} delay=${args.delayMs}ms`,
  );

  let candidates = await findReformatCandidateSections(db, {
    clientId: args.clientId,
  });
  console.log(
    `[backfill-common-issues-reformat] ${candidates.length} Intake/Sales section(s) need a reformat pass.`,
  );
  if (args.limit !== undefined) candidates = candidates.slice(0, args.limit);
  if (candidates.length === 0) {
    console.log("[backfill-common-issues-reformat] nothing to do.");
    process.exit(0);
  }

  let processed = 0;
  let changed = 0;
  let degraded = 0;
  let structureRepaired = 0;
  for (const cand of candidates) {
    const res = await processReformatSection({ db, apply: args.apply }, cand);
    processed++;
    if (res.kind === "skipped_placeholder") {
      if (!args.quiet) {
        console.log(
          `  SKIP report=${cand.reportId} section=${cand.sectionKey} row=${cand.id} — placeholder`,
        );
      }
      continue;
    }
    if (res.changed) changed++;
    if (res.degraded) degraded++;
    if (res.structureRepaired) structureRepaired++;
    if (!args.quiet) {
      console.log(
        `  ${args.apply ? "WROTE" : "WOULD WRITE"} report=${cand.reportId} section=${cand.sectionKey} row=${cand.id} changed=${res.changed} degraded=${res.degraded}${res.structureRepaired ? " structure-repair(no-AI)" : ""}${res.reason ? ` (${res.reason})` : ""}`,
      );
    }
    if (args.delayMs) await sleep(args.delayMs);
  }

  console.log(
    `[backfill-common-issues-reformat] ${mode} done — processed=${processed} changed=${changed} degraded(fallback)=${degraded} structureRepaired(no-AI)=${structureRepaired}.`,
  );
  if (!args.apply) {
    console.log(
      `[backfill-common-issues-reformat] DRY RUN — re-run with --apply to write ${processed} section(s).`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-common-issues-reformat] FAILED", err);
  process.exit(1);
});
