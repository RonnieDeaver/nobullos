// @db-pool-intent: ambient

/**
 * Sheets connector registry — live NoBull data sources that can be inserted
 * as refreshable data blocks into a workbook sheet.
 *
 * Each connector has:
 *   - id: stable machine identifier
 *   - label: human-readable name shown in the Insert Data dialog
 *   - description: one-line summary
 *   - paramSchema: Zod schema for the parameters the user provides
 *   - query: async function that fetches data, role-filtered by the caller's
 *             user id and role
 *
 * Convention: query() returns { headers: string[], rows: CellValue[][] }.
 * A CellValue is string | number | null.
 *
 * Role filtering: ceo sees all clients; account_manager sees only clients
 * they own; other roles get an empty result.
 */

import { z } from "zod";
import { getDb } from "../db";
import { sql } from "drizzle-orm";

export type CellValue = string | number | null;

export interface ConnectorResult {
  headers: string[];
  rows: CellValue[][];
}

export interface ConnectorDef {
  id: string;
  label: string;
  description: string;
  paramSchema: z.ZodTypeAny;
  query: (params: unknown, userId: string, userRole: string) => Promise<ConnectorResult>;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function assertClientAccess(
  clientId: string,
  userId: string,
  userRole: string,
): Promise<void> {
  if (userRole === "ceo" || userRole === "admin") return;
  if (userRole === "account_manager" || userRole === "team_lead") {
    const rows = await getDb().execute(
      sql`SELECT id FROM clients WHERE id = ${clientId} AND owner_id = ${userId} LIMIT 1`,
    );
    if ((rows as unknown as any[]).length === 0) {
      throw new Error("Client not found or not accessible");
    }
    return;
  }
  throw new Error("Insufficient role to read client data");
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return String(d);
  return dt.toISOString().slice(0, 10);
}

function fmtNum(v: unknown, decimals = 2): number | null {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

// ─── connector: report_metrics ────────────────────────────────────────────────

const reportMetricsParamSchema = z.object({
  clientId: z.string().min(1),
  reportId: z.string().optional(),
});

async function queryReportMetrics(
  rawParams: unknown,
  userId: string,
  userRole: string,
): Promise<ConnectorResult> {
  const params = reportMetricsParamSchema.parse(rawParams);
  await assertClientAccess(params.clientId, userId, userRole);

  let reportId = params.reportId;
  if (!reportId) {
    const latestRows = await getDb().execute(sql`
      SELECT id FROM reports
      WHERE client_id = ${params.clientId}
      ORDER BY report_month DESC NULLS LAST, created_at DESC
      LIMIT 1
    `);
    const first = (latestRows as unknown as any[])[0];
    if (!first) {
      return { headers: ["Note"], rows: [["No reports found for this client"]] };
    }
    reportId = first.id as string;
  }

  const reportRows = await getDb().execute(sql`
    SELECT r.report_month, r.title, rs.section_key, rs.data
    FROM report_sections rs
    JOIN reports r ON r.id = rs.report_id
    WHERE rs.report_id = ${reportId}
    ORDER BY rs.section_key
  `);

  if ((reportRows as unknown as any[]).length === 0) {
    return {
      headers: ["Note"],
      rows: [["No sections found in this report"]],
    };
  }

  const headers = ["Report Month", "Section", "Content"];
  const rows: CellValue[][] = (reportRows as unknown as any[]).map((r: any) => {
    const month = r.report_month ? fmtDate(r.report_month) : "";
    const section = String(r.section_key ?? "");
    let content = "";
    try {
      const data = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      if (data && typeof data === "object") {
        content = data.content ?? data.text ?? data.summary ?? JSON.stringify(data).slice(0, 200);
      } else {
        content = String(data ?? "");
      }
    } catch {
      content = String(r.data ?? "");
    }
    return [month, section, content.slice(0, 500)];
  });

  return { headers, rows };
}

// ─── connector: google_ads_spend ──────────────────────────────────────────────

const googleAdsSpendParamSchema = z.object({
  clientId: z.string().min(1),
  dateStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

async function queryGoogleAdsSpend(
  rawParams: unknown,
  userId: string,
  userRole: string,
): Promise<ConnectorResult> {
  const params = googleAdsSpendParamSchema.parse(rawParams);
  await assertClientAccess(params.clientId, userId, userRole);

  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  const dateEnd = params.dateEnd ?? today.toISOString().slice(0, 10);
  const dateStart = params.dateStart ?? thirtyDaysAgo.toISOString().slice(0, 10);

  const customerRows = await getDb().execute(sql`
    SELECT customer_id FROM google_ads_customers
    WHERE nobull_client_id = ${params.clientId}
      AND sync_enabled = true
      AND (status IS DISTINCT FROM 'REMOVED')
    LIMIT 5
  `);

  if ((customerRows as unknown as any[]).length === 0) {
    return {
      headers: ["Note"],
      rows: [["No Google Ads customer linked to this client"]],
    };
  }

  const customerIds = (customerRows as unknown as any[]).map((r: any) => String(r.customer_id));
  const customerIdList = customerIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");

  const statsRows = await getDb().execute(sql.raw(`
    SELECT
      c.name AS campaign_name,
      c.status AS campaign_status,
      s.date,
      s.cost_dollars AS spend,
      s.impressions,
      s.clicks,
      s.conversions,
      s.average_cpc_dollars AS avg_cpc
    FROM google_ads_campaign_daily_stats s
    JOIN google_ads_campaigns c
      ON c.campaign_id = s.campaign_id AND c.customer_id = s.customer_id
    WHERE s.customer_id IN (${customerIdList})
      AND s.date >= '${dateStart}'
      AND s.date <= '${dateEnd}'
    ORDER BY s.date DESC, s.cost_dollars DESC
    LIMIT 500
  `));

  if ((statsRows as unknown as any[]).length === 0) {
    return {
      headers: ["Note"],
      rows: [["No campaign stats in the selected date range"]],
    };
  }

  const headers = ["Date", "Campaign", "Status", "Spend ($)", "Impressions", "Clicks", "Conversions", "Avg CPC ($)"];
  const rows: CellValue[][] = (statsRows as unknown as any[]).map((r: any) => [
    fmtDate(r.date),
    String(r.campaign_name ?? ""),
    String(r.campaign_status ?? ""),
    fmtNum(r.spend, 2),
    fmtNum(r.impressions, 0),
    fmtNum(r.clicks, 0),
    fmtNum(r.conversions, 0),
    fmtNum(r.avg_cpc, 2),
  ]);

  return { headers, rows };
}

// ─── connector: front_coverage ────────────────────────────────────────────────

const frontCoverageParamSchema = z.object({
  months: z.number().int().min(1).max(24).optional().default(6),
});

async function queryFrontCoverage(
  rawParams: unknown,
  _userId: string,
  userRole: string,
): Promise<ConnectorResult> {
  if (!["ceo", "admin", "team_lead", "account_manager"].includes(userRole)) {
    throw new Error("Insufficient role to read coverage data");
  }
  const params = frontCoverageParamSchema.parse(rawParams);

  const rows = await getDb().execute(sql`
    SELECT
      month_key,
      front_total_messages,
      fetched_into_nobull,
      applied_into_nobull,
      denominator_source,
      denominator_unit,
      status,
      refreshed_at
    FROM front_analytics_monthly_coverage
    ORDER BY month_key DESC
    LIMIT ${params.months}
  `);

  if ((rows as unknown as any[]).length === 0) {
    return {
      headers: ["Note"],
      rows: [["No Front coverage data available"]],
    };
  }

  const headers = ["Month", "Total Messages", "Fetched", "Applied", "Coverage %", "Status", "Last Refreshed"];
  const data: CellValue[][] = (rows as unknown as any[]).map((r: any) => {
    const total = Number(r.front_total_messages ?? 0);
    const applied = Number(r.applied_into_nobull ?? 0);
    const pct = total > 0 ? fmtNum((applied / total) * 100, 1) : null;
    return [
      String(r.month_key ?? ""),
      fmtNum(r.front_total_messages, 0),
      fmtNum(r.fetched_into_nobull, 0),
      fmtNum(r.applied_into_nobull, 0),
      pct,
      String(r.status ?? ""),
      r.refreshed_at ? fmtDate(r.refreshed_at) : "",
    ];
  });

  return { headers, rows: data };
}

// ─── connector: semrush_keywords ──────────────────────────────────────────────

const semrushKeywordsParamSchema = z.object({
  clientId: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional().default(25),
});

async function querySemrushKeywords(
  rawParams: unknown,
  userId: string,
  userRole: string,
): Promise<ConnectorResult> {
  const params = semrushKeywordsParamSchema.parse(rawParams);
  await assertClientAccess(params.clientId, userId, userRole);

  const rows = await getDb().execute(sql`
    SELECT
      h.keyword_name,
      h.location_name,
      h.business_name,
      h.share_of_voice_raw,
      h.report_date
    FROM heatmap_snapshots h
    WHERE h.client_id = ${params.clientId}
      AND h.report_date = (
        SELECT MAX(h2.report_date)
        FROM heatmap_snapshots h2
        WHERE h2.client_id = h.client_id
      )
    ORDER BY h.share_of_voice_raw DESC NULLS LAST, h.keyword_name
    LIMIT ${params.limit}
  `);

  if ((rows as unknown as any[]).length === 0) {
    return {
      headers: ["Note"],
      rows: [["No SEMrush keyword data for this client"]],
    };
  }

  const headers = ["Keyword", "Location", "Business", "Share of Voice", "Report Date"];
  const data: CellValue[][] = (rows as unknown as any[]).map((r: any) => [
    String(r.keyword_name ?? ""),
    String(r.location_name ?? ""),
    String(r.business_name ?? ""),
    fmtNum(r.share_of_voice_raw, 1),
    fmtDate(r.report_date),
  ]);

  return { headers, rows: data };
}

// ─── registry ─────────────────────────────────────────────────────────────────

export const CONNECTORS: ConnectorDef[] = [
  {
    id: "report_metrics",
    label: "Monthly Report Metrics",
    description: "Report section data from the latest (or a specific) monthly client report.",
    paramSchema: reportMetricsParamSchema,
    query: queryReportMetrics,
  },
  {
    id: "google_ads_spend",
    label: "Google Ads Campaign Spend",
    description: "Daily campaign spend, clicks, conversions, and avg CPC for a client's linked Ads account.",
    paramSchema: googleAdsSpendParamSchema,
    query: queryGoogleAdsSpend,
  },
  {
    id: "front_coverage",
    label: "Front Coverage Summary",
    description: "Monthly Front message coverage — total, fetched, applied, and coverage % over recent months.",
    paramSchema: frontCoverageParamSchema,
    query: queryFrontCoverage,
  },
  {
    id: "semrush_keywords",
    label: "SEMrush Keyword Positions",
    description: "Top keyword share-of-voice positions from the latest heatmap snapshot for a client.",
    paramSchema: semrushKeywordsParamSchema,
    query: querySemrushKeywords,
  },
];

export function getConnector(id: string): ConnectorDef | undefined {
  return CONNECTORS.find((c) => c.id === id);
}

export function listConnectors(): Omit<ConnectorDef, "query" | "paramSchema">[] {
  return CONNECTORS.map(({ id, label, description }) => ({ id, label, description }));
}
