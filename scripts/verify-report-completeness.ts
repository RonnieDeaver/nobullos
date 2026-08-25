/**
 * Task #4552 — report-completeness sweep for the dev-refresh tool.
 *
 * Read-only verification that the (restored) database's reports are fully
 * populated. This checks restore FIDELITY, not prod's editorial habits:
 * prod writes sections incrementally (verified against the 2026-08-11 prod
 * dump: final reports commonly hold 2-3 of the 4 keys, fresh drafts zero),
 * so "every report has all four sections" would false-flag a faithful
 * restore. What must hold instead:
 *
 *   1. Every `report_sections.section_key` is a KNOWN key (intake / sales /
 *      marketing / nextActions — the set server/routes/reports.ts writes)
 *      and no section row is orphaned (report_id without a reports row).
 *      A FINAL report with ZERO sections is flagged too — that shape does
 *      not exist in prod, so it signals wholesale section loss.
 *   2. Every heatmap snapshot referenced from section JSON
 *      (`heatmapSnapshotId` / `heatmapSnapshotIds`, wherever they appear in
 *      the payload — see shared/models/reports.ts) resolves to a real
 *      `heatmap_snapshots` row.
 *   3. Prints row counts for every report-relevant table plus the
 *      section-count histogram; a MISSING table or an empty `reports`
 *      table is a failure (a restore that lost tables/rows must never read
 *      as a pass).
 *
 * Exits non-zero and names each offender when anything dangles. Safe to run
 * anywhere (read-only) — used by scripts/refresh-dev-db-from-backup.ts
 * right after a restore, and standalone:
 *
 *   npx tsx scripts/verify-report-completeness.ts
 */

import { Client } from "pg";
import { SEASONAL_TRENDS_AI_SECTION_KEY } from "../server/services/practiceAreaTrendAnalysis";
import { SLIDE_VERDICTS_SECTION_KEY } from "../server/services/slideVerdicts";

/**
 * The known section keys the report pipeline writes: the four operator
 * sections (server/routes/reports.ts) plus the internal AI cache rows.
 * The internal keys are IMPORTED from their owning modules (Task #4691) so
 * this list can't rot when a key is renamed — a new section key still needs
 * an entry here, but the completeness sweep names it loudly when it appears.
 */
export const KNOWN_REPORT_SECTION_KEYS = [
  "intake",
  "sales",
  "marketing",
  "nextActions",
  SEASONAL_TRENDS_AI_SECTION_KEY,
  SLIDE_VERDICTS_SECTION_KEY,
] as const;

/** Report-relevant tables whose row counts the sweep prints (and requires to exist). */
export const REPORT_TABLE_COUNTS = [
  "clients",
  "client_locations",
  "command_panels",
  "reports",
  "report_sections",
  "webhook_import_logs",
  "heatmap_snapshots",
  "heatmap_points",
  "heatmap_metrics",
  "heatmap_competitor_snapshots",
  "heatmap_overrides",
] as const;

/**
 * Deep-walk arbitrary section JSON collecting heatmap snapshot references.
 * The schema puts them under per-location marketing entries, but the walk is
 * generic on purpose: any future section that references a snapshot by these
 * key names is verified automatically.
 */
export function collectHeatmapSnapshotRefs(
  value: unknown,
  out: Set<string> = new Set(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectHeatmapSnapshotRefs(v, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "heatmapSnapshotId" && typeof v === "string" && v.length > 0) {
        out.add(v);
      } else if (k === "heatmapSnapshotIds" && Array.isArray(v)) {
        for (const id of v) {
          if (typeof id === "string" && id.length > 0) out.add(id);
        }
      } else {
        collectHeatmapSnapshotRefs(v, out);
      }
    }
  }
  return out;
}

export interface CompletenessResult {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
  reportCount: number;
  refCount: number;
  /** reports-by-section-count histogram, e.g. { "0": 16, "4": 279 } */
  sectionHistogram: Record<string, number>;
}

export async function runReportCompletenessSweep(
  client: Client,
): Promise<CompletenessResult> {
  const problems: string[] = [];
  const counts: Record<string, number> = {};

  // Table inventory + row counts. -1 marks a missing table (named as a
  // problem, not thrown, so ONE run reports every offender at once).
  for (const table of REPORT_TABLE_COUNTS) {
    const reg = await client.query("select to_regclass($1) as r", [
      `public.${table}`,
    ]);
    if (!reg.rows[0]?.r) {
      counts[table] = -1;
      problems.push(`table missing after restore: ${table}`);
      continue;
    }
    const res = await client.query(
      `select count(*)::int as n from public."${table}"`,
    );
    counts[table] = res.rows[0]?.n ?? 0;
  }

  // Section integrity per report. Prod writes sections incrementally, so a
  // low section count alone is faithful data — the failure shapes are
  // unknown keys, orphaned sections, and section-less FINAL reports.
  let reportCount = 0;
  const sectionHistogram: Record<string, number> = {};
  if (counts["reports"] >= 0 && counts["report_sections"] >= 0) {
    const known = new Set<string>(KNOWN_REPORT_SECTION_KEYS);
    const reports = await client.query(
      `select r.id, r.status,
              coalesce(array_agg(s.section_key) filter (where s.section_key is not null), '{}') as keys
         from public.reports r
         left join public.report_sections s on s.report_id = r.id
        group by r.id, r.status
        order by r.id`,
    );
    reportCount = reports.rows.length;
    for (const row of reports.rows) {
      const keys: string[] = row.keys ?? [];
      sectionHistogram[String(keys.length)] =
        (sectionHistogram[String(keys.length)] ?? 0) + 1;
      const unknown = keys.filter((k) => !known.has(k));
      if (unknown.length > 0) {
        problems.push(
          `report ${row.id} (status=${row.status}) has unknown section key(s): ${unknown.join(", ")}`,
        );
      }
      if (row.status === "final" && keys.length === 0) {
        problems.push(
          `report ${row.id} is FINAL but has zero sections — prod never has section-less finals, sections were lost`,
        );
      }
    }
    if (reportCount === 0) {
      problems.push(
        "reports table is EMPTY — prod has reports, so a zero-report restore is incomplete",
      );
    }
    const orphans = await client.query(
      `select s.report_id, count(*)::int as n
         from public.report_sections s
         left join public.reports r on r.id = s.report_id
        where r.id is null
        group by s.report_id`,
    );
    for (const row of orphans.rows) {
      problems.push(
        `orphaned report_sections rows (${row.n}) for missing report ${row.report_id}`,
      );
    }
  }

  // Heatmap snapshot references must resolve to real heatmap_snapshots rows.
  let refCount = 0;
  if (counts["report_sections"] >= 0 && counts["heatmap_snapshots"] >= 0) {
    const have = new Set<string>(
      (
        await client.query("select id::text as id from public.heatmap_snapshots")
      ).rows.map((r: { id: string }) => r.id),
    );
    const sections = await client.query(
      "select report_id, section_key, data from public.report_sections",
    );
    const seen = new Set<string>();
    for (const row of sections.rows) {
      const refs = collectHeatmapSnapshotRefs(row.data);
      for (const id of refs) {
        seen.add(id);
        if (!have.has(id)) {
          problems.push(
            `report ${row.report_id} section ${row.section_key}: dangling heatmap snapshot ref ${id}`,
          );
        }
      }
    }
    refCount = seen.size;
  }

  return {
    ok: problems.length === 0,
    problems,
    counts,
    reportCount,
    refCount,
    sectionHistogram,
  };
}

export function printCompletenessResult(r: CompletenessResult): void {
  console.log("[report-completeness] table row counts:");
  for (const table of REPORT_TABLE_COUNTS) {
    const n = r.counts[table];
    console.log(
      `  ${table.padEnd(30)} ${n === -1 ? "MISSING" : (n ?? "(not checked)")}`,
    );
  }
  const histo = Object.keys(r.sectionHistogram)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => `${k} section(s)=${r.sectionHistogram[k]} report(s)`)
    .join(", ");
  console.log(
    `[report-completeness] reports checked: ${r.reportCount} [${histo || "none"}]; distinct heatmap refs checked: ${r.refCount}`,
  );
  if (r.ok) {
    console.log(
      `[report-completeness] PASS — section keys sane (${KNOWN_REPORT_SECTION_KEYS.join("/")}), no orphans, no section-less finals, every heatmap ref resolves`,
    );
  } else {
    console.error(
      `[report-completeness] FAIL — ${r.problems.length} problem(s):`,
    );
    for (const p of r.problems) console.error(`  - ${p}`);
  }
}

async function cliMain(): Promise<number> {
  const url =
    process.env.DATABASE_URL_MIGRATIONS ??
    process.env.DATABASE_URL_DIRECT ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error("[report-completeness] no DATABASE_URL set");
    return 2;
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await runReportCompletenessSweep(client);
    printCompletenessResult(result);
    return result.ok ? 0 : 1;
  } finally {
    await client.end();
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith("verify-report-completeness.ts") ?? false);
if (isMain) {
  cliMain()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(
        `[report-completeness] ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
}
