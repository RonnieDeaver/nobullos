/**
 * Ads OS · GAds Budget Pacing tool (/ads-os/a/{cid}/pacing) — port of the
 * bundle's frontend/src/components/BudgetPacing.tsx.
 *
 * NoBull OS adaptation: the bundle App resolved the account from in-memory
 * state before rendering; here the CID comes from the wouter route and the
 * account context resolves from the monitored-accounts list (best-effort —
 * the report itself carries account_name, so an unresolved list never blocks
 * the tool). Auto-runs on open; Re-run forces a fresh pull past the 1h cache.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { BudgetPacingReport, CampaignPacingRow } from "./lib/types";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { PacingChart } from "./components/PacingChart";
import { moneyWhole as money, round1, formatId } from "./lib/format";
import { paceStatus } from "./lib/pace";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { EmptyState } from "@/components/kit/EmptyState";

export default function BudgetPacingToolPage() {
  const [, params] = useRoute("/ads-os/a/:cid/pacing");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<BudgetPacingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);

  function load(force = false) {
    setLoading(true);
    setError(null);
    api
      .budgetPacing(cid, { force })
      .then(setReport)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setReport(null);
    load();
    // Best-effort name resolution for the header while the report computes.
    api
      .monitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) setAccountName(a.descriptive_name);
      })
      .catch(() => {}); // header falls back to the report's own account_name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  const cur = report?.currency_code ?? "";
  const name = accountName ?? report?.account_name ?? formatId(cid);

  return (
    <AdsOsShell>
      <div className="report" data-testid="page-ads-os-pacing">
        <Breadcrumbs view="pacing" account={{ customer_id: cid, descriptive_name: name }} />
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">
              Budget pacing · {formatId(cid)}
              {report ? ` · ${report.from_cache ? "cached" : "fresh"}` : ""}
              {report?.eligible ? ` · ${report.monitored_campaigns} labeled campaign(s)` : ""}
            </span>
          </div>
          <div className="report-actions">
            <button
              className="btn-secondary"
              onClick={() => setEditing(true)}
              data-testid="button-edit-criteria"
            >
              Edit criteria
            </button>
            {/* Task #4977: force-refresh recomputes + persists via vendor/AI
                calls — CEO-only trigger, hidden for read-only staff. */}
            {isCeo && (
            <button
              className="btn-secondary"
              onClick={() => load(true)}
              disabled={loading}
              data-testid="button-rerun-pacing"
            >
              Re-run
            </button>
            )}
          </div>
        </div>

        {editing && (
          <CriteriaEditor
            account={{ customer_id: cid, descriptive_name: name }}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              // Reload must force a fresh recompute for every role — the
              // server's pacing force cache-bust is intentionally open to
              // all staff (see server/routes/adsOs.ts header comment), so
              // whoever just saved their edit sees it reflected immediately.
              load(true);
            }}
          />
        )}

        {loading && (
          <div className="panel loading">
            <div className="spinner" />
            Computing budget pacing for <strong>{name}</strong>…
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-pacing-error">
            {error}
          </div>
        )}

        {!loading && !error && report && !report.eligible && (
          <div className="panel ki-notenrolled" data-testid="text-pacing-not-enrolled">
            <strong>Not enrolled in Budget Pacing</strong>
            <div className="muted" style={{ marginTop: 8 }}>{report.scope_note}</div>
          </div>
        )}

        {!loading && !error && report && report.eligible && (
          <>
            {report.warnings.length > 0 && (
              <div className="banner banner-amber">
                {report.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            <div className="ki-summary bp-tiles">
              <Tile
                label="Monthly budget"
                value={report.monthly_budget != null ? money(report.monthly_budget, cur) : "—"}
                sub={budgetSourceLabel(report)}
              />
              <Tile
                label="MTD spend"
                value={money(report.mtd_spend, cur)}
                sub={`to yesterday · ${money(report.avg_daily_spend_mtd, cur)}/day`}
              />
              <PaceTile report={report} />
              <Tile
                label="Recommended daily"
                value={
                  report.recommended_daily_budget != null
                    ? money(report.recommended_daily_budget, cur)
                    : "—"
                }
                sub="to hit target"
              />
              <BaselineDailyTile report={report} cur={cur} />
            </div>

            {report.monthly_budget == null && (
              <div className="ki-hint" style={{ marginBottom: 16 }}>
                No monthly budget found for this account. Set the account's{" "}
                <strong>Paid Search Budget</strong> on its Google Ads subtask in the ClickUp
                Client List to enable pacing.
              </div>
            )}

            <PacingChart
              points={report.daily_spend}
              cur={cur}
              hasBudget={report.monthly_budget != null}
            />

            <div className="ki-table-card">
              <div className="ki-table-head">
                <span className="muted" data-testid="text-schedule-context">
                  Campaign breakdown · {report.scheduled_days_elapsed}/{report.total_scheduled_days}{" "}
                  scheduled days elapsed
                  {report.schedule_days.length ? ` (${report.schedule_days.join(", ")})` : " (every day)"}
                  {report.schedule_source === "inferred"
                    ? " · schedule inferred from recent spend — save criteria to override"
                    : ""}
                </span>
              </div>
              <div className="ki-table-scroll">
                <table className="ki-table bp-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th className="num">Daily budget</th>
                      <th className="num">Avg daily spend MTD</th>
                      <th className="num">Impr. share</th>
                      <th className="num">Lost IS (budget)</th>
                      <th className="num">Lost IS (rank)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.campaigns.map((c) => (
                      <Row key={c.campaign_id} c={c} cur={cur} />
                    ))}
                    {report.campaigns.length === 0 && (
                      <tr>
                        <td colSpan={6} className="pad">
                          <EmptyState
                            title="No campaigns to pace"
                            description="This account has no enabled campaigns carrying the monitoring label, so there's nothing to pace against budget yet."
                            hint="Enable the account's monitored campaigns in Google Ads, or add the monitoring label to a campaign in the ClickUp Client List."
                            testId="empty-bp-campaigns"
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </AdsOsShell>
  );
}

function Row({ c, cur }: { c: CampaignPacingRow; cur: string }) {
  return (
    <tr data-testid={`row-campaign-${c.campaign_id}`}>
      <td className="bp-name" title={c.name}>
        {c.name}
        {c.status !== "ENABLED" && (
          <span className="bp-status" title={`Campaign is ${c.status.toLowerCase()} — spend still counted`}>
            {c.status.toLowerCase()}
          </span>
        )}
      </td>
      <td className="num">{money(c.current_daily_budget, cur)}</td>
      <td className="num">{money(c.avg_daily_spend_mtd, cur)}</td>
      <td className="num">{pct(c.impr_share)}</td>
      <td className="num">{pct(c.search_lost_is_budget)}</td>
      <td className="num">{pct(c.search_lost_is_rank)}</td>
    </tr>
  );
}

function Tile({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  testId?: string;
}) {
  return (
    <div className="ki-stat bp-tile" data-testid={testId}>
      <div className="ki-stat-val">{value}</div>
      <div className="ki-stat-label">{label}</div>
      {sub && <div className="bp-tile-sub">{sub}</div>}
    </div>
  );
}

/** Task #3903: the platform baseline — monthly budget ÷ total scheduled days,
 *  i.e. what the daily budget should be set to in Google Ads from the monthly
 *  budget alone. Depends only on budget + schedule (never MTD spend), so it
 *  stays stable on the 1st when the pacing tile reads "Not started". A cached
 *  report from before the server field existed derives it from fields already
 *  in the doc; no budget → "—" (never a fake $0). */
function BaselineDailyTile({ report, cur }: { report: BudgetPacingReport; cur: string }) {
  const baseline =
    report.baseline_daily_budget ??
    (report.monthly_budget != null && report.total_scheduled_days > 0
      ? report.monthly_budget / report.total_scheduled_days
      : null);
  return (
    <Tile
      label="Baseline daily"
      value={baseline != null ? money(baseline, cur) : "—"}
      sub={
        baseline != null && report.monthly_budget != null
          ? `${money(report.monthly_budget, cur)} ÷ ${report.total_scheduled_days} scheduled days`
          : "monthly budget ÷ scheduled days"
      }
      testId="tile-baseline-daily"
    />
  );
}

function PaceTile({ report }: { report: BudgetPacingReport }) {
  const p = report.on_off_track_pct;
  // Task #3706: with a real budget and zero scheduled days elapsed (e.g. a
  // weekday-only account on the month's opening weekend) the tile reads
  // "Not started" — neutral, not a scary dash or −100%.
  const notStarted =
    p == null && report.monthly_budget != null && report.scheduled_days_elapsed === 0;
  const status = paceStatus(p, {
    budget: report.monthly_budget,
    scheduledDaysElapsed: report.scheduled_days_elapsed,
  });
  return (
    <div className={`ki-stat bp-tile bp-pace ${status.cls}`} data-testid="tile-pacing">
      <div className="ki-stat-val">
        {p == null ? (notStarted ? "Not started" : "—") : `${p > 0 ? "+" : ""}${round1(p)}%`}
      </div>
      <div className="ki-stat-label">Pacing</div>
      <div className="bp-tile-sub">{status.label}</div>
    </div>
  );
}

function budgetSourceLabel(r: BudgetPacingReport): string {
  if (r.budget_source === "clickup") return "from ClickUp";
  if (r.budget_source === "sheet") return "from sheet";
  return "not set";
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
