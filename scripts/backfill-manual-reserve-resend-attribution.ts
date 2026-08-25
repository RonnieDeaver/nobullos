/**
 * Task #1260 — Backfill resend attribution for older `manual_reserve_alert_dispatches`
 * rows that show "unknown" in the Health dashboard.
 *
 * Background
 * ----------
 * Task #798 added `triggered_by`, `trigger_source`, and `is_resend` columns to
 * `manual_reserve_alert_dispatches` via a runtime ALTER. Rows written before
 * the columns were added (and any rows ingested from the in-memory buffer
 * fallback) have NULL `triggered_by` / NULL `trigger_source` and the column
 * default `is_resend = false`, so the "Last resend by … (source)" badge
 * renders "unknown" for them.
 *
 * Inference rule
 * --------------
 * The resend path always writes a `sent` (or `failed` / `not_configured`)
 * dispatch shortly after a prior `failed` dispatch for the same
 * (metric, severity). Auto-firing dispatches that succeed on the first
 * attempt don't have a matching prior `failed` row. So: for every
 * dispatch row with `is_resend = false` AND `trigger_source IS NULL` whose
 * `status` is `sent` / `failed` / `not_configured`, if there exists a prior
 * dispatch row with `status = 'failed'`, the same `(metric, severity)`, and
 * a `timestamp` inside the lookback window, mark the row as a resend:
 *   - `is_resend = true`
 *   - `trigger_source = 'admin_ui'`
 *   - `triggered_by` is left NULL (we have no record of who clicked Resend)
 *
 * The default lookback window is 60 minutes, which comfortably covers the
 * operator click-through latency between seeing the failure and pressing
 * Resend.
 *
 * Behaviour
 * ---------
 * Default mode is dry-run: it prints the candidate count and a small sample
 * of (metric, severity, timestamp_iso, prior_failed_ts_iso) tuples. `--apply`
 * writes the inferred attribution via UPDATE. Idempotent — rows that already
 * have `is_resend = true` or a non-NULL `trigger_source` are skipped by the
 * WHERE clause, so re-runs are safe.
 *
 * Usage:
 *   tsx scripts/backfill-manual-reserve-resend-attribution.ts
 *   tsx scripts/backfill-manual-reserve-resend-attribution.ts --apply
 *   tsx scripts/backfill-manual-reserve-resend-attribution.ts --window-minutes=30 --apply
 */

import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { bindArrayParam } from "../server/utils/sqlArray";

type Args = { apply: boolean; windowMinutes: number };

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, windowMinutes: 60 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--window-minutes=")) {
      const v = Number(a.slice("--window-minutes=".length));
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`Invalid --window-minutes value: ${a}`);
        process.exit(2);
      }
      out.windowMinutes = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "scripts/backfill-manual-reserve-resend-attribution.ts [--apply] [--window-minutes=N]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

interface CandidateRow {
  id: number;
  timestamp: number;
  metric: string;
  severity: string;
  status: string;
  prior_failed_ts: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const windowMs = Math.round(args.windowMinutes * 60_000);

  // Ensure the columns exist (the runtime ALTER from Task #798 normally runs
  // on first read, but this script may execute before the server boots).
  await db.execute(sql`
    ALTER TABLE "manual_reserve_alert_dispatches"
      ADD COLUMN IF NOT EXISTS "triggered_by" varchar(128),
      ADD COLUMN IF NOT EXISTS "trigger_source" varchar(64),
      ADD COLUMN IF NOT EXISTS "is_resend" boolean NOT NULL DEFAULT false
  `);

  // Find candidates: rows with no attribution yet that have a prior `failed`
  // dispatch for the same (metric, severity) within the lookback window.
  const candidatesRes = await db.execute<any>(sql`
    SELECT
      d.id,
      d.timestamp,
      d.metric,
      d.severity,
      d.status,
      (
        SELECT MAX(p.timestamp)
        FROM manual_reserve_alert_dispatches p
        WHERE p.metric = d.metric
          AND p.severity = d.severity
          AND p.status = 'failed'
          AND p.timestamp < d.timestamp
          AND p.timestamp >= d.timestamp - ${windowMs}
      ) AS prior_failed_ts
    FROM manual_reserve_alert_dispatches d
    WHERE d.is_resend = false
      AND d.trigger_source IS NULL
      AND d.status IN ('sent', 'failed', 'not_configured')
    ORDER BY d.timestamp ASC
  `);
  const rawRows: any[] = Array.isArray(candidatesRes)
    ? candidatesRes
    : (candidatesRes as any).rows ?? [];

  const candidates: CandidateRow[] = rawRows
    .filter((r) => r.prior_failed_ts !== null && r.prior_failed_ts !== undefined)
    .map((r) => ({
      id: Number(r.id),
      timestamp: Number(r.timestamp),
      metric: String(r.metric),
      severity: String(r.severity),
      status: String(r.status),
      prior_failed_ts: Number(r.prior_failed_ts),
    }));

  if (candidates.length === 0) {
    console.log(
      `[backfill-manual-reserve-resend-attribution] No candidates inside a ${args.windowMinutes}m window. Nothing to do.`,
    );
    return;
  }

  const byStatus = new Map<string, number>();
  const byMetric = new Map<string, number>();
  for (const c of candidates) {
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
    const key = `${c.metric}:${c.severity}`;
    byMetric.set(key, (byMetric.get(key) ?? 0) + 1);
  }

  console.log(
    `[backfill-manual-reserve-resend-attribution] Found ${candidates.length} candidate row(s) within a ${args.windowMinutes}m window.`,
  );
  console.log(`[backfill-manual-reserve-resend-attribution] By status:`);
  for (const [s, n] of Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${s}: ${n}`);
  }
  console.log(`[backfill-manual-reserve-resend-attribution] By metric:severity (top 10):`);
  const topMetrics = Array.from(byMetric.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [k, n] of topMetrics) {
    console.log(`  - ${k}: ${n}`);
  }
  console.log(`[backfill-manual-reserve-resend-attribution] Sample (up to 5):`);
  for (const c of candidates.slice(0, 5)) {
    const tsIso = new Date(c.timestamp).toISOString();
    const priorIso = new Date(c.prior_failed_ts).toISOString();
    const gapSec = Math.round((c.timestamp - c.prior_failed_ts) / 1000);
    console.log(
      `  - id=${c.id} ${c.metric}/${c.severity} status=${c.status} ts=${tsIso} prior_failed=${priorIso} (+${gapSec}s)`,
    );
  }

  if (!args.apply) {
    console.log(
      `[backfill-manual-reserve-resend-attribution] Dry-run. Re-run with --apply to write ${candidates.length} row(s).`,
    );
    return;
  }

  // Re-apply the same WHERE predicate inside the UPDATE so a concurrent writer
  // (or a re-run) can't accidentally re-attribute a row that's already been
  // claimed by the live resend path.
  const ids = candidates.map((c) => c.id);
  const updateRes = await db.execute<any>(sql`
    UPDATE manual_reserve_alert_dispatches
       SET is_resend = true,
           trigger_source = 'admin_ui'
     WHERE id = ANY(${bindArrayParam(ids, "int")})
       AND is_resend = false
       AND trigger_source IS NULL
       AND status IN ('sent', 'failed', 'not_configured')
    RETURNING id
  `);
  const updatedRows: any[] = Array.isArray(updateRes)
    ? updateRes
    : (updateRes as any).rows ?? [];
  const written = updatedRows.length;
  console.log(
    `[backfill-manual-reserve-resend-attribution] Done. wrote=${written} of planned=${candidates.length}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[backfill-manual-reserve-resend-attribution] Fatal: ${err?.stack || err?.message || err}`,
    );
    process.exit(1);
  });
