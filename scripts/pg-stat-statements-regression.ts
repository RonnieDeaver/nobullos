/**
 * Task #1724 Phase 4.4 — Nightly pg_stat_statements regression scan.
 *
 * Queries the live `pg_stat_statements` view, diffs the per-query mean
 * execution time against `scripts/baselines/pg-stat-statements-baseline.json`,
 * and posts the top 5 regressions (ranked by
 * `(new_mean_ms - baseline_mean_ms) * new_calls` — i.e. estimated extra
 * latency contribution) to the queue-health Slack channel.
 *
 * Surfaces the same class of regression Task #1721 Phase 1.1 hand-fixed:
 * a hot path quietly growing its per-call cost. Phase 4.1's lint guard
 * catches new unattributed callers at PR time; this script catches the
 * "still attributed but suddenly 10× slower" case at runtime.
 *
 * Modes:
 *   (default)            Scan, report to stdout, post to Slack if
 *                        configured. Exit 0 even when regressions exist
 *                        — this is informational, not blocking.
 *   --update-baseline    Capture the current snapshot into the baseline
 *                        file. Used after a deliberate schema/index
 *                        change makes the prior baseline stale. Commit
 *                        the diff in the same PR.
 *   --dry-run            Skip the Slack post even if a channel is
 *                        configured.
 *
 * Requirements:
 *   - `DATABASE_URL` pointing at the target primary.
 *   - `pg_stat_statements` extension installed
 *     (`CREATE EXTENSION IF NOT EXISTS pg_stat_statements;`). If absent
 *     the script logs a single line and exits 0 — it does NOT page
 *     anyone — so it stays safe to wire into a nightly job before the
 *     prod extension is created (see PROD_REMEDIATION.md).
 *   - Optional `QUEUE_HEALTH_SLACK_CHANNEL` — the Slack channel id to
 *     post regressions into. If unset, the report only goes to stdout.
 *
 * The script depends only on `pg` so it can run from a thin nightly
 * container without booting the rest of the server.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";

const BASELINE_PATH = "scripts/baselines/pg-stat-statements-baseline.json";
const TOP_N = 5;
// Ignore queries that haven't been called enough times in the live
// snapshot to produce a meaningful mean. A handful of calls can swing
// `mean_exec_time` wildly and produce noisy alerts.
const DEFAULT_MIN_CALLS = 50;
// Don't flag tiny absolute regressions even if they're a big multiplier
// — going from 0.2 ms to 0.6 ms is statistically a 3× regression but
// operationally invisible.
const MIN_ABSOLUTE_DELTA_MS = 5;
// Don't flag small relative regressions: only sound the alarm if the
// new mean is at least 1.5× the baseline.
const MIN_RATIO = 1.5;

interface BaselineEntry {
  queryid: string;
  queryPreview: string;
  meanMs: number;
  calls: number;
}

interface BaselineFile {
  $schema?: string;
  comment?: string[];
  capturedAt: string | null;
  minCalls: number;
  queries: BaselineEntry[];
}

interface LiveRow {
  queryid: string;
  query: string;
  calls: number;
  mean_exec_time: number;
  total_exec_time: number;
}

interface Regression {
  queryid: string;
  queryPreview: string;
  baselineMeanMs: number;
  newMeanMs: number;
  ratio: number;
  newCalls: number;
  estimatedExtraMs: number;
}

function previewQueryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function loadBaseline(): BaselineFile {
  try {
    const raw = readFileSync(BASELINE_PATH, "utf8");
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return {
      capturedAt: null,
      minCalls: DEFAULT_MIN_CALLS,
      queries: [],
    };
  }
}

function saveBaseline(file: BaselineFile): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
}

async function ensureExtension(client: Client): Promise<boolean> {
  const res = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM pg_extension WHERE extname = 'pg_stat_statements'`,
  );
  return Number(res.rows[0]?.count ?? "0") > 0;
}

async function fetchSnapshot(client: Client, minCalls: number): Promise<LiveRow[]> {
  const res = await client.query<LiveRow>(
    `SELECT queryid::text AS queryid,
            query,
            calls::bigint::int AS calls,
            mean_exec_time,
            total_exec_time
       FROM pg_stat_statements
      WHERE calls >= $1
        AND query NOT ILIKE '%pg_stat_statements%'
        AND query NOT ILIKE 'SET %'
        AND query NOT ILIKE 'BEGIN%'
        AND query NOT ILIKE 'COMMIT%'
        AND query NOT ILIKE 'ROLLBACK%'`,
    [minCalls],
  );
  return res.rows;
}

function computeRegressions(
  baseline: BaselineFile,
  live: LiveRow[],
): Regression[] {
  const baselineById = new Map<string, BaselineEntry>();
  for (const entry of baseline.queries) baselineById.set(entry.queryid, entry);

  const out: Regression[] = [];
  for (const row of live) {
    const prior = baselineById.get(row.queryid);
    if (!prior) continue; // brand-new query shapes are out of scope here
    const newMeanMs = Number(row.mean_exec_time);
    const baselineMeanMs = prior.meanMs;
    if (!Number.isFinite(newMeanMs) || !Number.isFinite(baselineMeanMs)) continue;
    if (baselineMeanMs <= 0) continue;
    const delta = newMeanMs - baselineMeanMs;
    if (delta < MIN_ABSOLUTE_DELTA_MS) continue;
    const ratio = newMeanMs / baselineMeanMs;
    if (ratio < MIN_RATIO) continue;
    out.push({
      queryid: row.queryid,
      queryPreview: previewQueryText(row.query),
      baselineMeanMs,
      newMeanMs,
      ratio,
      newCalls: Number(row.calls),
      estimatedExtraMs: delta * Number(row.calls),
    });
  }
  out.sort((a, b) => b.estimatedExtraMs - a.estimatedExtraMs);
  return out.slice(0, TOP_N);
}

function renderReport(regressions: Regression[]): string {
  if (regressions.length === 0) {
    return "✓ pg_stat_statements regression scan: no regressions over baseline.";
  }
  const lines: string[] = [
    `⚠ pg_stat_statements regression scan — top ${regressions.length} regressions`,
    "",
  ];
  for (const r of regressions) {
    lines.push(
      `  • queryid=${r.queryid}  ${r.baselineMeanMs.toFixed(2)} ms → ${r.newMeanMs.toFixed(2)} ms ` +
        `(×${r.ratio.toFixed(2)}, ${r.newCalls.toLocaleString()} calls, ` +
        `+${Math.round(r.estimatedExtraMs).toLocaleString()} ms total)`,
    );
    lines.push(`      ${r.queryPreview}`);
  }
  return lines.join("\n");
}

async function postToSlack(text: string): Promise<{ posted: boolean; reason: string }> {
  const channel = process.env.QUEUE_HEALTH_SLACK_CHANNEL;
  if (!channel) return { posted: false, reason: "QUEUE_HEALTH_SLACK_CHANNEL unset" };
  try {
    // Lazy-import slackIntegration so the script stays runnable in a
    // thin container that doesn't have the full server bundle loaded.
    const { postMessage, isConnected } = await import("../server/services/slackIntegration");
    if (!(await isConnected())) {
      return { posted: false, reason: "slackIntegration not connected" };
    }
    await postMessage(channel, text);
    return { posted: true, reason: "posted" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { posted: false, reason: `slack post failed: ${message}` };
  }
}

function captureAsBaseline(live: LiveRow[], minCalls: number): BaselineFile {
  return {
    capturedAt: new Date().toISOString(),
    minCalls,
    queries: live
      .map<BaselineEntry>((row) => ({
        queryid: row.queryid,
        queryPreview: previewQueryText(row.query),
        meanMs: Number(row.mean_exec_time),
        calls: Number(row.calls),
      }))
      .sort((a, b) => a.queryid.localeCompare(b.queryid)),
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const updateBaseline = args.has("--update-baseline");
  const dryRun = args.has("--dry-run");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("pg-stat-statements-regression: DATABASE_URL not set");
    process.exit(2);
  }

  const baseline = loadBaseline();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (!(await ensureExtension(client))) {
      console.log(
        "pg-stat-statements-regression: extension not installed on target — skipping. " +
          "Run `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` on the primary " +
          "to enable (see PROD_REMEDIATION.md).",
      );
      process.exit(0);
    }
    const minCalls = baseline.minCalls ?? DEFAULT_MIN_CALLS;
    const live = await fetchSnapshot(client, minCalls);

    if (updateBaseline) {
      const refreshed: BaselineFile = {
        ...baseline,
        ...captureAsBaseline(live, minCalls),
        comment: baseline.comment,
        $schema: baseline.$schema,
      };
      saveBaseline(refreshed);
      console.log(
        `pg-stat-statements-regression: baseline refreshed — captured ${refreshed.queries.length} queries.`,
      );
      process.exit(0);
    }

    if (baseline.queries.length === 0) {
      console.log(
        "pg-stat-statements-regression: baseline is empty — run with --update-baseline to seed it. " +
          `Live snapshot has ${live.length} qualifying queries (minCalls=${minCalls}).`,
      );
      process.exit(0);
    }

    const regressions = computeRegressions(baseline, live);
    const report = renderReport(regressions);
    console.log(report);

    if (regressions.length > 0 && !dryRun) {
      const slack = await postToSlack(report);
      console.log(`slack: ${slack.posted ? "posted" : "skipped"} (${slack.reason})`);
    }
    process.exit(0);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("pg-stat-statements-regression: fatal", err);
  process.exit(1);
});
