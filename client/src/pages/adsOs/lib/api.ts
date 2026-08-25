/**
 * Ads OS API client — port of the bundle's frontend/src/api.ts `req` helper,
 * pointed at the module's /api/ads-os/* namespace. Plain fetch (not the repo's
 * apiRequest) so error `detail` bodies map to readable messages exactly like
 * the bundle: the dashboards render `e.message` in their error panels/banners.
 */

import type {
  AmDashboardData,
  AuditReport,
  BudgetPacingReport,
  ClickUpTaskRef,
  ClientCriteria,
  ClientLogSummary,
  ClientPerformance,
  ClientProfile,
  ClientsResponse,
  CombinedDashboardResponse,
  CriteriaResponse,
  DashboardResponse,
  KeywordFinderReport,
  KeywordIntelReport,
  LsaDashboardResponse,
  LsaPacingReport,
  MonitoredAccount,
  Product,
  PyramidReport,
  RunAlertsSummary,
  ScoreHistoryResponse,
  SiblingResponse,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Same-origin; session cookies flow automatically.
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new ApiError("Signed out — log in again to view Ads OS.", 401);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      const d = body.detail ?? body.error ?? detail;
      detail = typeof d === "string" ? d : JSON.stringify(d);
    } catch {
      /* non-JSON error body */
    }
    // Never throw an empty message: over HTTP/2 statusText is "" and a non-JSON
    // body leaves detail blank — the page would stick on "Loading…" forever.
    throw new ApiError(detail || `Request failed (HTTP ${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export interface DashParams {
  force?: boolean;
  window: number;
  compare: string;
}

function dashQuery({ force, window, compare }: DashParams): string {
  const q = new URLSearchParams({ window: String(window), compare });
  if (force) q.set("force", "true");
  return q.toString();
}

export const api = {
  dashboard: (p: DashParams) =>
    req<DashboardResponse>(`/api/ads-os/dashboard?${dashQuery(p)}`),
  lsaDashboard: (p: DashParams) =>
    req<LsaDashboardResponse>(`/api/ads-os/lsa/dashboard?${dashQuery(p)}`),
  combinedDashboard: (p: DashParams) =>
    req<CombinedDashboardResponse>(`/api/ads-os/combined/dashboard?${dashQuery(p)}`),
  monitoredAccounts: () =>
    req<{ accounts: MonitoredAccount[] }>("/api/ads-os/monitored-accounts").then((r) => r.accounts),
  lsaMonitoredAccounts: () =>
    req<{ accounts: MonitoredAccount[] }>("/api/ads-os/lsa/monitored-accounts").then((r) => r.accounts),
  clients: () => req<ClientsResponse>("/api/ads-os/clients"),
  // Force-refresh the ClickUp directory bundle (Task #3609).
  refreshDirectory: () =>
    req<{ ok: boolean; clients: number; fetched_at: string }>(
      "/api/ads-os/directory/refresh",
      { method: "POST" },
    ),
  // Phase 2: budget pacing + client criteria
  budgetPacing: (cid: string, opts?: { force?: boolean }) =>
    req<BudgetPacingReport>(`/api/ads-os/budget-pacing/${cid}${opts?.force ? "?force=1" : ""}`),
  lsaPacing: (cid: string, opts?: { force?: boolean }) =>
    req<LsaPacingReport>(`/api/ads-os/lsa/pacing/${cid}${opts?.force ? "?force=1" : ""}`),
  // Phase 3: hygiene audits
  audit: (cid: string, opts?: { lookbackDays?: number; force?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.lookbackDays) params.set("lookback_days", String(opts.lookbackDays));
    if (opts?.force) params.set("force", "true");
    const qs = params.toString();
    return req<AuditReport>(`/api/ads-os/audit/${cid}${qs ? `?${qs}` : ""}`);
  },
  auditHistory: (cid: string) =>
    req<ScoreHistoryResponse>(`/api/ads-os/audit/${cid}/history`),
  lsaHygieneHistory: (cid: string) =>
    req<ScoreHistoryResponse>(`/api/ads-os/lsa/hygiene/${cid}/history`),
  runStaleAudits: () =>
    req<{ requested: number; ran: number }>("/api/ads-os/dashboard/run-audits", { method: "POST" }),
  lsaHygiene: (cid: string, opts?: { lookbackDays?: number; force?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.lookbackDays) params.set("lookback_days", String(opts.lookbackDays));
    if (opts?.force) params.set("force", "true");
    const qs = params.toString();
    return req<AuditReport>(`/api/ads-os/lsa/hygiene/${cid}${qs ? `?${qs}` : ""}`);
  },
  lsaRunStaleAudits: () =>
    req<{ requested: number; ran: number }>("/api/ads-os/lsa/dashboard/run-audits", { method: "POST" }),
  getCriteria: (cid: string) => req<CriteriaResponse>(`/api/ads-os/clients/${cid}/criteria`),
  saveCriteria: (
    cid: string,
    criteria: ClientCriteria,
    practiceAreaSyncBase: string[],
  ) =>
    req<{ ok: boolean; updated_at: string }>(`/api/ads-os/clients/${cid}/criteria`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...criteria,
        practice_area_sync_base: practiceAreaSyncBase,
      }),
    }),
  // Phase 4: Search Term Analyzer
  keywordIntel: (cid: string, opts?: { lookbackDays?: number; force?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.lookbackDays) params.set("lookback_days", String(opts.lookbackDays));
    if (opts?.force) params.set("force", "true");
    const qs = params.toString();
    return req<KeywordIntelReport>(`/api/ads-os/keyword-intel/${cid}${qs ? `?${qs}` : ""}`);
  },
  keywordFinder: (cid: string, opts?: { lookbackDays?: number; force?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.lookbackDays) params.set("lookback_days", String(opts.lookbackDays));
    if (opts?.force) params.set("force", "true");
    const qs = params.toString();
    return req<KeywordFinderReport>(`/api/ads-os/keyword-intel/${cid}/keywords${qs ? `?${qs}` : ""}`);
  },
  markKeywordActioned: (cid: string, searchTerm: string, undo: boolean) =>
    req<{ ok: boolean }>(`/api/ads-os/keyword-intel/${cid}/keywords/actioned`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search_term: searchTerm, undo }),
    }),
  // Phase 5: Pyramid Breakdown
  pyramid: (cid: string, opts?: { force?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.force) params.set("force", "true");
    const qs = params.toString();
    return req<PyramidReport>(`/api/ads-os/pyramid/${cid}${qs ? `?${qs}` : ""}`);
  },
  // Phase 6: client profile + performance + log summary
  clientProfile: (name: string) =>
    req<ClientProfile>(`/api/ads-os/client/profile?name=${encodeURIComponent(name)}`),
  clientPerformance: (name: string, start: string, end: string) =>
    req<ClientPerformance>(
      `/api/ads-os/client/performance?name=${encodeURIComponent(name)}&start=${start}&end=${end}`
    ),
  clientLogSummary: (name: string, force = false) =>
    req<ClientLogSummary>(
      `/api/ads-os/client/log-summary?name=${encodeURIComponent(name)}${force ? "&force=true" : ""}`
    ),
  clientSibling: (cid: string) => req<SiblingResponse>(`/api/ads-os/clients/${cid}/sibling`),
  // Phase 6: alerts recompute + ClickUp tickets. All three return the server's
  // run summary — the dashboards inspect the per-product account counts to
  // surface an "enrollment resolved empty" notice.
  runAlerts: () =>
    req<RunAlertsSummary>("/api/ads-os/dashboard/run-alerts", {
      method: "POST",
    }),
  lsaRunAlerts: () =>
    req<RunAlertsSummary>("/api/ads-os/lsa/dashboard/run-alerts", {
      method: "POST",
    }),
  combinedRunAlerts: () =>
    req<RunAlertsSummary>("/api/ads-os/combined/dashboard/run-alerts", {
      method: "POST",
    }),
  clickupEnabled: () => req<{ enabled: boolean }>("/api/ads-os/clickup/enabled"),
  createClickupTask: (product: Product, customerId: string, code: string) =>
    req<ClickUpTaskRef>("/api/ads-os/clickup/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product, customer_id: customerId, code }),
    }),
  // AM Dashboard (Task #3988): one launch card per client with per-account
  // deep-link buttons, plus the on-demand recompute of the two overlays the
  // board displays but does not itself produce.
  amDashboard: () => req<AmDashboardData>("/api/ads-os/am/dashboard"),
  // Recompute the AM Dashboard's two overlays — account alerts (the ⚠ badge)
  // and the Paused/Off verification (the ✓/✗ on the status chips) — without
  // waiting for the morning cron. Wired into the board's Refresh button.
  refreshAmDashboard: () =>
    req<{
      // Both halves are isolated server-side and the call stays 200 when either
      // fails, so each carries its own optional `error` rather than sinking the
      // other.
      alerts: { error?: string } & Record<string, unknown>;
      // `saved: false` = computed but the store write failed (chips come back
      // bare and look like the check never ran). `skipped` = deliberately kept
      // the previous batch: ClickUp unreachable, no paused/off accounts, or
      // every account errored.
      status_checks: { checked?: number; saved?: boolean; error?: string; skipped?: string };
    }>("/api/ads-os/am/dashboard/refresh", { method: "POST" }),
  // Task #4879: on-demand Paused/Off verification from the individual GAds /
  // LSA dashboards. Returns the same shape as StatusCheckRunResult — `checked`
  // (how many accounts were verified), `saved` (whether the batch was written
  // to the store), `skipped` (reason the batch was kept unchanged), `errors`.
  runStatusChecks: () =>
    req<{ checked?: number; saved?: boolean; errors?: number; skipped?: string; mismatches?: number }>(
      "/api/ads-os/dashboard/run-status-checks",
      { method: "POST" },
    ),
  lsaRunStatusChecks: () =>
    req<{ checked?: number; saved?: boolean; errors?: number; skipped?: string; mismatches?: number }>(
      "/api/ads-os/lsa/dashboard/run-status-checks",
      { method: "POST" },
    ),
};
