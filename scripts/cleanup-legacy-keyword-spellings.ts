/**
 * Task #791 / Task #2476 — Clean up legacy non-canonical keyword spellings
 * in heatmap_snapshots.
 *
 * Background
 * ----------
 * The write path now normalizes every `keywordName` through
 * `normalizeKeyword()` (trim, collapse internal whitespace, lowercase)
 * before insert, so all new snapshots land under their canonical spelling.
 * Pre-existing rows, however, may still be stored under raw spellings
 * (e.g. "Plumber", "  plumber  ", "plumber  near me"). Charts and the
 * coverage / dedup lookups that group by raw `keywordName` therefore see
 * historical duplicates that the new write path can no longer cause.
 *
 * `scripts/audit-keyword-normalization.ts` reports those rows. This script
 * rewrites them in place: every `heatmap_snapshots` row whose
 * `keyword_name` differs from the canonical form gets UPDATE'd to it.
 *
 * The rewrite/count/constraint logic is shared verbatim with the
 * `cleanup_legacy_keyword_spellings` CEO prod-action via
 * `server/services/legacyKeywordSpellingCleanup.ts` so the two stay in
 * lockstep. NOTE (Task #2476): the dev workspace can only READ production,
 * so running this CLI in dev only ever touches the dev DB — to actually
 * rewrite prod rows, press the CEO prod-action (it runs inside the deployed
 * app). See memory "Backfill from read-only-prod dev".
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: it counts `heatmap_snapshots` rows whose raw
 * `keyword_name` is not already canonical, prints the planned change count
 * and a sample of the rewrites, reports whether the migration-0061 CHECK
 * constraint is present, and exits. `--apply` performs the rewrite in
 * batches and then ensures the CHECK constraint exists. Idempotent — the
 * WHERE clause filters to rows that are still non-canonical, so re-runs
 * against an already-cleaned table are no-ops.
 *
 * The rewrite is a pure rename of the `keyword_name` column. It does not
 * merge rows: if both "Plumber" and "plumber" already exist for the same
 * (campaignId, locationId), both rows survive with `keyword_name="plumber"`.
 * After the rewrite, downstream charts that GROUP BY `keyword_name` will
 * naturally aggregate the previously-duplicate rows.
 *
 * Usage:
 *   tsx scripts/cleanup-legacy-keyword-spellings.ts
 *   tsx scripts/cleanup-legacy-keyword-spellings.ts --apply
 */

import { sql } from "drizzle-orm";
import { workerDb as db } from "../server/db";
import { heatmapSnapshots } from "@shared/schema";
import { normalizeKeyword } from "../shared/keywordNormalization";
import {
  countNonCanonicalKeywordSnapshots,
  rewriteNonCanonicalKeywordBatch,
  isCanonicalKeywordConstraintPresent,
  ensureCanonicalKeywordConstraint,
  KEYWORD_SPELLING_CLEANUP_BATCH,
} from "../server/services/legacyKeywordSpellingCleanup";

type Args = { apply: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--help" || a === "-h") {
      console.log("scripts/cleanup-legacy-keyword-spellings.ts [--apply]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Pull every distinct raw keyword spelling along with the snapshot count
  // it covers, for a readable dry-run sample. Bounded by keyword-inventory
  // cardinality, not the full snapshot row count, so this is a cheap pass.
  const rawRows = await db
    .select({
      keywordName: heatmapSnapshots.keywordName,
      n: sql<number>`count(*)::int`,
    })
    .from(heatmapSnapshots)
    .groupBy(heatmapSnapshots.keywordName);

  const planned: Array<{ raw: string; canonical: string; n: number }> = [];
  let totalSnapshots = 0;
  for (const r of rawRows) {
    const canonical = normalizeKeyword(r.keywordName);
    if (canonical === r.keywordName) continue;
    planned.push({ raw: r.keywordName, canonical, n: r.n });
    totalSnapshots += r.n;
  }

  const constraintPresent = await isCanonicalKeywordConstraintPresent(db);
  console.log(
    `[cleanup-legacy-keyword-spellings] migration-0061 CHECK constraint ` +
      `present: ${constraintPresent}.`,
  );

  if (planned.length === 0) {
    console.log(
      `[cleanup-legacy-keyword-spellings] No non-canonical keyword spellings found.`,
    );
    if (!constraintPresent && args.apply) {
      const added = await ensureCanonicalKeywordConstraint(db);
      console.log(
        `[cleanup-legacy-keyword-spellings] CHECK constraint ${added ? "added" : "already present"}.`,
      );
    }
    return;
  }

  console.log(
    `[cleanup-legacy-keyword-spellings] Found ${planned.length} non-canonical raw spelling(s) covering ${totalSnapshots} snapshot row(s).`,
  );
  const sample = planned.slice().sort((a, b) => b.n - a.n).slice(0, 25);
  console.log(`[cleanup-legacy-keyword-spellings] Sample (top ${sample.length} by row count):`);
  for (const p of sample) {
    console.log(`  - "${p.raw}" -> "${p.canonical}" (${p.n} snapshot${p.n === 1 ? "" : "s"})`);
  }

  if (!args.apply) {
    console.log(
      `[cleanup-legacy-keyword-spellings] Dry-run. Re-run with --apply to rewrite ${totalSnapshots} row(s).`,
    );
    return;
  }

  // Rewrite in batches (FOR UPDATE SKIP LOCKED, well under the 10s DB-hold
  // cap each) so a huge table never holds a single giant transaction. The
  // shared core's predicate only matches still-non-canonical rows, so this
  // converges.
  let written = 0;
  for (;;) {
    const n = await rewriteNonCanonicalKeywordBatch(db, KEYWORD_SPELLING_CLEANUP_BATCH);
    if (n === 0) break;
    written += n;
  }

  const remaining = await countNonCanonicalKeywordSnapshots(db);
  // Every row is canonical now, so the constraint can be added safely.
  const added = await ensureCanonicalKeywordConstraint(db);

  console.log(
    `[cleanup-legacy-keyword-spellings] Done. wrote=${written} (remaining non-canonical=${remaining}); CHECK constraint ${added ? "added" : "already present"}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[cleanup-legacy-keyword-spellings] Fatal: ${err?.stack || err?.message || err}`,
    );
    process.exit(1);
  });
