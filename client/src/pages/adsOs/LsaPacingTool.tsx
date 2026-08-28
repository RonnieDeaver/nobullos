/**
 * Ads OS · LSA Budget Pacing tool (/ads-os/lsa/a/{cid}/pacing) — port of the
 * bundle's frontend/src/components/LsaPacing.tsx.
 *
 * LSA is paced MONTHLY (like GAds) over the client's LSA ad schedule from
 * criteria (empty = every day); the only LSA-specific bit is that the account
 * is configured with a weekly budget, so the recommendation is a weekly budget
 * (recommended_daily × scheduled days per week) and the last-30-day spend vs
 * monthly budget is surfaced (the BUD-02 signal). Account context resolves
 * from the LSA monitored-accounts list (city suffix), falling back to the
 * report.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { LsaPacingReport } from "./lib/types";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { PacingChart } from "./components/PacingChart";
import { moneyWhole as money, round1, formatId } from "./lib/format";
import { paceStatus } from "./lib/pace";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";

export default function LsaPacingToolPage() {
  const [, params] = useRoute("/ads-os/lsa/a/:cid/pacing");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<LsaPacingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);

  function load(force = false) {
    setLoading(true);
    setError(null);
    api
      .lsaPacing(cid, { force })
      .then(setReport)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setReport(null);
    load();
    api
      .lsaMonitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) {
          setAccountName(a.descriptive_name);
          setCity(a.city ?? null);
        }
      })
      .catch(() => {}); // header falls back to the report's own account_name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  const cur = report?.currency_code ?? "";
  const name = accountName ?? report?.account_name ?? formatId(cid);

  return (
    <AdsOsShell>
      <div className="report" data-testid="page-ads-os-lsa-pacing">
        <Breadcrumbs
          view="lsa-pacing"
          account={{ customer_id: cid, descriptive_name: name, city: city ?? undefined }}
        />
        <div className="report-top">
          <div className="report-title">
            <h2>
              {name}
              {city && <span className="dash-city">{city}</span>}
            </h2>
            <span className="muted">
              Budget pacing · {formatId(cid)}
              {report ? ` · ${report.from_cache ? "cached" : "fresh"}` : ""}
              {report?.eligible ? ` · ${report.monitored_campaigns} LSA campaign(s)` : ""}
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
            Computing LSA budget pacing for{" "}
            <strong>
              {name}
              {city ? ` — ${city}` : ""}
            </strong>
            …
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-pacing-error">
            {error}
          </div>
        )}

        {!loading && !error && report && !report.eligible && (
          <div className="panel ki-notenrolled" data-testid="text-pacing-not-enrolled">
            <strong>Not enrolled in LSA Budget Pacing</strong>
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
                label="Recommended weekly"
                value={
                  report.recommended_weekly_budget != null
                    ? money(report.recommended_weekly_budget, cur)
                    : "—"
                }
                sub={
                  report.weeks_remaining != null
                    ? `to hit budget · ~${report.weeks_remaining} wk left`
                    : "to hit budget"
                }
              />
              <BaselineWeeklyTile report={report} cur={cur} />
            </div>

            {/* Which schedule the pacing math is based on (mirrors the GAds
                tool's scheduled-days explainer). */}
            <div className="ki-hint" style={{ marginBottom: 16 }} data-testid="text-lsa-schedule">
              Paced over{" "}
              <strong>
                {report.schedule_days.length ? report.schedule_days.join(", ") : "every day"}
              </strong>{" "}
              · {report.days_elapsed} scheduled day(s) elapsed this month.
            </div>

            <div className="ki-hint" style={{ marginBottom: 16 }} data-testid="text-lsa-30d-signal">
              Last 30 days spent <strong>{money(report.spend_last_30d, cur)}</strong>
              {report.monthly_budget != null ? (
                <>
                  {" "}of a {money(report.monthly_budget, cur)} monthly budget (
                  {Math.round((report.spend_last_30d / report.monthly_budget) * 100)}%).
                </>
              ) : (
                <>
                  {". No monthly budget found — set the account's "}
                  <strong>Paid Search Budget</strong>
                  {" on its LSA subtask in the ClickUp Client List to enable pacing."}
                </>
              )}
            </div>

            <PacingChart
              points={report.daily_spend}
              cur={cur}
              hasBudget={report.monthly_budget != null}
            />
          </>
        )}
      </div>
    </AdsOsShell>
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

/** Client-side mirror of the engine's scheduledDaysPerWeek (dedup, case/space-
 *  insensitive, empty/unrecognised → 7) — subtitle context only; the tile's
 *  value itself comes from the server whenever the field exists. */
const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function lsaDaysPerWeek(days: string[]): number {
  const n = new Set(
    days.map((d) => d.trim().toLowerCase()).filter((d) => WEEKDAY_NAMES.includes(d)),
  ).size;
  return n > 0 ? n : 7;
}

/** Task #3903: the platform baseline — (monthly budget ÷ total scheduled days)
 *  × scheduled serving days per week, i.e. the weekly budget to set in LSA
 *  from the monthly budget alone (every-day account: monthly ÷ days in month
 *  × 7). Depends only on budget + schedule (never MTD spend), so it's stable
 *  on the 1st. A cached report from before the field existed also lacks
 *  total_scheduled_days → "—" (never a crash or a fake $0). */
function BaselineWeeklyTile({ report, cur }: { report: LsaPacingReport; cur: string }) {
  const total = report.total_scheduled_days;
  const dpw = lsaDaysPerWeek(report.schedule_days);
  const baseline =
    report.baseline_weekly_budget ??
    (report.monthly_budget != null && total != null && total > 0
      ? (report.monthly_budget / total) * dpw
      : null);
  return (
    <Tile
      label="Baseline weekly"
      value={baseline != null ? money(baseline, cur) : "—"}
      sub={
        baseline != null && report.monthly_budget != null && total != null
          ? `${money(report.monthly_budget, cur)} ÷ ${total} scheduled days × ${dpw}/wk`
          : "monthly budget → weekly"
      }
      testId="tile-baseline-weekly"
    />
  );
}

function PaceTile({ report }: { report: LsaPacingReport }) {
  const p = report.on_off_track_pct;
  const status = paceStatus(p);
  return (
    <div className={`ki-stat bp-tile bp-pace ${status.cls}`} data-testid="tile-pacing">
      <div className="ki-stat-val">{p == null ? "—" : `${p > 0 ? "+" : ""}${round1(p)}%`}</div>
      <div className="ki-stat-label">Pacing</div>
      <div className="bp-tile-sub">{status.label}</div>
    </div>
  );
}

function budgetSourceLabel(r: LsaPacingReport): string {
  if (r.budget_source === "clickup") return "from ClickUp";
  if (r.budget_source === "sheet") return "from sheet";
  return "not set";
}
