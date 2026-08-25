/**
 * Ads OS · Main Dashboard (/ads-os) — port of the bundle's
 * frontend/src/components/CombinedDashboard.tsx.
 *
 * Combined client overview: GAds + LSA merged into one row per client. Spend =
 * GAds cost (labeled campaigns) + LSA cost; Leads = GAds primary conversions +
 * LSA charged leads; CPL = combined spend / combined leads. Clicking a row opens
 * the client's profile page (/ads-os/client/{name} — a stub until Phase 6).
 *
 * Summary tiles follow the selected Doer and Checker ownership slice, while text
 * search and the Needs attention toggle remain table-only. Phase 2:
 * the Budget pacing column blends every member account's pacing overlay
 * (expected-to-date weighting, server-side) into one pill with a per-account
 * hover breakdown. Phase 6 (§8): Refresh recomputes BOTH products' alerts
 * (no Slack — the morning cron owns the digest) before reloading, surfacing a
 * notice when the recompute fails or resolves zero enrolled accounts (§14).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { api } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import {
  clientNeedsAttention,
  countClientsNeedingAttention,
  zeroAccountNotice,
} from "./lib/alerts";
import type { CombinedDashboardRow, CombinedMember } from "./lib/types";
import { MetricPill, MetricChange } from "./components/MetricPill";
import { RangeSelector, DEFAULT_RANGE, compareLabel, type DashRange } from "./components/RangeSelector";
import { readDashCache, writeDashCache } from "./lib/dashCache";
import { useStickyFilter } from "./lib/stickyFilter";
import { money, round1, firstName, distinctPeople, practiceAreaText, scheduleLabel } from "./lib/format";
import { SortHeader } from "./components/SortHeader";
import { StatTile } from "./components/StatTile";
import { AdsOsShell } from "./components/AdsOsShell";
import { AdsStatusChip } from "./components/StatusChip";
import { paceClass } from "./lib/pace";
import { PacePill, type PaceRow, type PaceSubLine } from "./components/PacePill";
import { EmptyState } from "@/components/kit/EmptyState";
import { ClientAlertMenu } from "./components/ClientAlertMenu";

type SortKey = "name" | "practiceAreas" | "spend" | "leads" | "cpl" | "pacing" | "doer" | "checker";
type SortDir = "asc" | "desc";
type CachedDash = { rows: CombinedDashboardRow[]; cached: boolean; live: boolean | null; staleSince?: string | null };

export default function MainDashboardPage() {
  const [, setLocation] = useLocation();
  const [range, setRange] = useState<DashRange>(DEFAULT_RANGE);
  const cacheKey = `combined:${range.window}:${range.compare}`;
  const [rows, setRows] = useState<CombinedDashboardRow[] | null>(
    () => readDashCache<CachedDash>(cacheKey)?.rows ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !readDashCache(cacheKey));
  const [cached, setCached] = useState(() => readDashCache<CachedDash>(cacheKey)?.cached ?? false);
  const [live, setLive] = useState<boolean | null>(() => readDashCache<CachedDash>(cacheKey)?.live ?? null);
  const [staleSince, setStaleSince] = useState<string | null>(() => readDashCache<CachedDash>(cacheKey)?.staleSince ?? null);
  const [bundleAgeMs, setBundleAgeMs] = useState<number | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Task #4977: non-CEO staff get a read-only Ads OS — CEO-only trigger/edit
  // controls are hidden and Refresh skips the CEO-only recompute POST.
  const isCeo = useIsCeo();

  const [alertsNote, setAlertsNote] = useState<string | null>(null);
  // Ads OS store health from the freshest payload (Task #3706); null until a
  // live response arrives (session-cache hydrates rows only — no stale banner).
  const [storeOk, setStoreOk] = useState<boolean | null>(null);
  const [storeReason, setStoreReason] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [doerFilter, setDoerFilter] = useStickyFilter("combined:doer");
  const [checkerFilter, setCheckerFilter] = useStickyFilter("combined:checker");
  const [attnOnly, setAttnOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const reqIdRef = useRef(0); // latest in-flight load; older responses are ignored

  function openClient(name: string) {
    setLocation(`/ads-os/client/${encodeURIComponent(name)}`);
  }

  function load(force = false) {
    // Ignore out-of-order responses (a slow older range must not overwrite the newer).
    const myId = ++reqIdRef.current;
    const stale = () => myId !== reqIdRef.current;
    // Only show the full-page spinner when there's nothing cached to show.
    if (force || !readDashCache(cacheKey)) setLoading(true);
    setError(null);
    return api
      .combinedDashboard({ force, window: range.window, compare: range.compare })
      .then((r) => {
        if (stale()) return;
        setRows(r.rows);
        setCached(!!r.from_cache);
        setLive(r.clickup_live);
        setReason(r.clickup_reason ?? null);
        setStaleSince(r.clickup_stale_since ?? null);
        setBundleAgeMs(r.clickup_bundle_age_ms ?? null);
        setStoreOk(typeof r.store_ok === "boolean" ? r.store_ok : null);
        setStoreReason(r.store_reason ?? null);
        writeDashCache<CachedDash>(cacheKey, { rows: r.rows, cached: !!r.from_cache, live: r.clickup_live, staleSince: r.clickup_stale_since ?? null });
      })
      .catch((e) => {
        if (!stale()) setError(e.message);
      })
      .finally(() => {
        if (!stale()) setLoading(false);
      });
  }

  // Show cached data instantly when we have it for this exact range (e.g. on
  // nav-back) and revalidate quietly; otherwise (a new window) show the spinner
  // rather than the previous window's numbers.
  useEffect(() => {
    const c = readDashCache<CachedDash>(cacheKey);
    setRows(c ? c.rows : null);
    setCached(c ? c.cached : false);
    setLive(c ? c.live : null);
    setStaleSince(c ? (c.staleSince ?? null) : null);
    setLoading(!c);
    void load(false); // fire-and-forget: errors handled inside load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  async function refresh() {
    setRefreshing(true);
    setAlertsNote(null);
    // §8: the Main Dashboard's Refresh recomputes BOTH products' alerts first
    // (no Slack — the morning cron owns the digest), so the per-product
    // dashboards and client-profile chips are fresh after the reload. A failed
    // or zero-account recompute surfaces a non-blocking notice instead of
    // silently rendering stale data (§14).
    // Non-CEO viewers can't run the recompute (server 403s it) — their
    // Refresh is a plain force reload of the stored data.
    if (isCeo) try {
      const r = await api.combinedRunAlerts();
      // EITHER product resolving zero is surfaced by name — a partial
      // recompute (LSA enrollment empty while GAds ran fine) leaves that
      // product's stored alerts stale and must not pass for fresh.
      setAlertsNote(zeroAccountNotice(r, ["gads", "lsa"]));
    } catch (e) {
      setAlertsNote(
        `Alerts recompute failed — alert data shows the last stored state${
          e instanceof Error && e.message ? ` (${e.message})` : ""
        }.`
      );
    }
    // Task #4977: force reload recomputes+persists via vendor calls — CEO-only.
    // Non-CEO Refresh re-reads the stored/cached data without forcing.
    await load(isCeo);
    setRefreshing(false);
  }

  function clickSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" }
    );
  }

  const cur = useMemo(() => dominantCurrency(rows), [rows]);
  const cmp = compareLabel(range);

  const doers = useMemo(() => distinctPeople(rows, "doer"), [rows]);
  const checkers = useMemo(() => distinctPeople(rows, "checker"), [rows]);

  // Ownership-scoped summary: Doer and Checker use the same AND semantics as
  // the table filters. Text search and Needs attention remain table-only.
  const summaryRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (doerFilter && r.doer !== doerFilter) return false;
      if (checkerFilter && r.checker !== checkerFilter) return false;
      return true;
    });
  }, [rows, doerFilter, checkerFilter]);

  const summary = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    let spend = 0, spendPrev = 0, leads = 0, leadsPrev = 0;
    for (const r of summaryRows) {
      spend += r.spend_30d;
      spendPrev += r.spend_prev;
      leads += r.leads_30d;
      leadsPrev += r.leads_prev;
    }
    return {
      spend, spendPrev, leads, leadsPrev,
      cpl: leads > 0 ? spend / leads : null,
      cplPrev: leadsPrev > 0 ? spendPrev / leadsPrev : null,
      attn: countClientsNeedingAttention(summaryRows),
    };
  }, [rows, summaryRows]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    // Hide fully switched-off clients (no On/Paused account, no Off account still
    // spending) from the monitoring board; they remain reachable via the client profile.
    // `!== false` so a pre-field cached payload (undefined) still shows.
    const board = rows.filter((r) => r.has_active_monitoring !== false);
    const mul = sort.dir === "asc" ? 1 : -1;
    const str = (r: CombinedDashboardRow): string | null =>
      sort.key === "name" ? r.client
      : sort.key === "practiceAreas" ? practiceAreaText(r.practice_areas)
      : sort.key === "doer" ? r.doer
      : sort.key === "checker" ? r.checker
      : null;
    const num = (r: CombinedDashboardRow): number | null =>
      sort.key === "spend" ? r.spend_30d
      : sort.key === "leads" ? r.leads_30d
      : sort.key === "cpl" ? r.cpl_30d
      : sort.key === "pacing" ? r.pacing_pct
      : 0;
    const isText = sort.key === "name" || sort.key === "practiceAreas" || sort.key === "doer" || sort.key === "checker";
    return [...board].sort((a, b) => {
      if (isText) {
        const as = str(a), bs = str(b);
        if (!as && !bs) return 0;
        if (!as) return 1;   // blanks sort last regardless of direction
        if (!bs) return -1;
        return mul * as.toLowerCase().localeCompare(bs.toLowerCase());
      }
      const av = num(a), bv = num(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return mul * (av - bv);
    });
  }, [rows, sort]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
    const terms = q ? q.split(/\s+/) : [];
    return sorted.filter((r) => {
      if (doerFilter && r.doer !== doerFilter) return false;
      if (checkerFilter && r.checker !== checkerFilter) return false;
      if (attnOnly && !clientNeedsAttention(r.alerts)) return false;
      const hay = `${r.client} ${practiceAreaText(r.practice_areas)} ${r.members.map((m) => `${m.descriptive_name} ${m.city ?? ""} ${m.customer_id}`).join(" ")}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [sorted, filter, doerFilter, checkerFilter, attnOnly]);

  if (error && !rows) {
    return (
      <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
        <div className="panel error" data-testid="panel-combined-error">
          Couldn’t load combined overview: {error}{" "}
          <button className="link" onClick={() => load(isCeo)}>Retry</button>
        </div>
      </AdsOsShell>
    );
  }

  return (
    <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
      <div className="dash" data-testid="page-ads-os-main">
        {error && rows && (
          <div className="banner banner-amber">
            Refresh failed — showing the last loaded data.{" "}
            <button className="link" onClick={() => load(isCeo)}>Retry</button>
          </div>
        )}
        {alertsNote && (
          <div className="banner banner-amber" data-testid="text-combined-alerts-note">
            {alertsNote}
          </div>
        )}
        <div className="dash-head">
          <div>
            <h2>Client overview</h2>
            <span className="muted">
              {rows ? `${sorted.length} clients · Google Ads + LSA` : "Loading…"}
              {rows ? ` · ${cached ? "cached" : "fresh"}` : ""}
            </span>
          </div>
        </div>

        {summary && (
          <div className="dash-summary">
            <StatTile
              val={
                <>
                  {money(summary.spend, cur)}
                  <MetricChange cur={summary.spend} prev={summary.spendPrev} kind="neutral" title={cmp} />
                </>
              }
              label={`Spend · ${range.window}d`}
            />
            <StatTile
              val={
                <>
                  {round1(summary.leads)}
                  <MetricChange cur={summary.leads} prev={summary.leadsPrev} kind="up-good" title={cmp} />
                </>
              }
              label={`Leads · ${range.window}d`}
            />
            <StatTile
              val={
                summary.cpl === null ? (
                  "—"
                ) : (
                  <>
                    {money(summary.cpl, cur)}
                    <MetricChange cur={summary.cpl} prev={summary.cplPrev} kind="down-good" title={cmp} />
                  </>
                )
              }
              label={`Blended CPL · ${range.window}d`}
            />
            <StatTile val={summaryRows.length} label="Clients" />
            <StatTile
              val={summary.attn}
              label="Needs attention"
              attn
              pressed={attnOnly}
              onClick={() => setAttnOnly((value) => !value)}
              testId="button-combined-needs-attention"
            />
          </div>
        )}

        <div className="dash-bar">
          <div className="dash-bar-left">
            <input
              className="dash-filter"
              placeholder="Filter clients by name, account or ID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter clients"
              data-testid="input-combined-filter"
            />
            {(doers.length > 0 || checkers.length > 0) && (
              <div className="dash-people-filter">
                <select
                  className="dash-dd"
                  value={doerFilter}
                  onChange={(e) => setDoerFilter(e.target.value)}
                  aria-label="Filter by doer"
                  title="Show only clients this person is the doer for"
                  data-testid="select-combined-doer"
                >
                  <option value="">All doers</option>
                  {doers.map((p) => (
                    <option key={p} value={p}>{firstName(p)}</option>
                  ))}
                </select>
                <select
                  className="dash-dd"
                  value={checkerFilter}
                  onChange={(e) => setCheckerFilter(e.target.value)}
                  aria-label="Filter by checker"
                  title="Show only clients this person is the checker for"
                  data-testid="select-combined-checker"
                >
                  <option value="">All checkers</option>
                  {checkers.map((p) => (
                    <option key={p} value={p}>{firstName(p)}</option>
                  ))}
                </select>
              </div>
            )}
            <button
              type="button"
              className={`dash-toggle${attnOnly ? " on" : ""}`}
              role="switch"
              aria-checked={attnOnly}
              onClick={() => setAttnOnly((value) => !value)}
              title="Show only clients with critical or high alerts"
              data-testid="toggle-combined-needs-attention"
            >
              <span className="sw" /> Needs attention only
            </button>
          </div>
          <div className="dash-bar-right">
            <RangeSelector range={range} onChange={setRange} disabled={loading || refreshing} />
            <button className="btn-secondary" onClick={refresh} disabled={loading || refreshing} data-testid="button-combined-refresh">
              {refreshing ? "Refreshing…" : loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>

        {loading && !rows ? (
          <div className="panel loading">
            <div className="spinner" />
            Pulling {range.window}-day Google Ads + LSA metrics for every client…
          </div>
        ) : (
          <div className="ki-table-wrap dash-table-wrap">
            <table className="ki-table dash-table">
              <thead>
                <tr>
                  <SortHeader label="Client" k="name" sort={sort} onSort={clickSort} />
                  <SortHeader label="Practice Area" k="practiceAreas" sort={sort} onSort={clickSort} />
                  <SortHeader label="Doer" k="doer" sort={sort} onSort={clickSort} />
                  <SortHeader label="Checker" k="checker" sort={sort} onSort={clickSort} />
                  <SortHeader label={`Spend ${range.window}d`} k="spend" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`Leads ${range.window}d`} k="leads" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`CPL ${range.window}d`} k="cpl" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Budget pacing" k="pacing" sort={sort} onSort={clickSort} num />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const c = r.currency_code ?? "";
                  const attn = clientNeedsAttention(r.alerts);
                  const tag = r.has_gads && r.has_lsa ? "GAds + LSA" : r.has_gads ? "GAds" : "LSA";
                  const spendTitle = splitTitle("Spend", r.gads_spend_30d, r.lsa_spend_30d, r, c);
                  const leadsTitle = splitTitle("Leads", r.gads_leads_30d, r.lsa_leads_30d, r, "");
                  return (
                    <tr
                      key={r.client}
                      className={`dash-row cmb-row${attn ? " row-attn" : ""}`}
                      title="Open client profile"
                      onClick={() => openClient(r.client)}
                      data-testid={`row-combined-${r.client}`}
                    >
                      <td>
                        <button
                          type="button"
                          className="dash-name cmb-client-name"
                          onClick={(event) => {
                            event.stopPropagation();
                            openClient(r.client);
                          }}
                          title={`Open ${r.client} profile`}
                          data-testid={`button-combined-client-${r.client}`}
                        >
                          {r.client}
                        </button>
                        <span className={`cmb-tag ${r.has_gads && r.has_lsa ? "both" : r.has_gads ? "g" : "l"}`}>
                          {tag}
                        </span>
                        <ClientAlertMenu
                          summary={r.alerts}
                          client={r.client}
                          variant="row"
                          testId={`button-combined-alerts-${r.client}`}
                        />
                        {/* Task #4964: "Setup needed" — a GAds member has active
                            campaigns but ZERO monitor labels, so its $0.00 here is a
                            labeling gap, not real zero spend and not a fetch failure. */}
                        {r.members.some((m) => m.zero_label) && (
                          <span
                            className="cmb-setup"
                            title="This client has a Google Ads account with active campaigns but no NBM_GADS_MONITOR_CAMPAIGN labels — its metrics read $0.00 until the monitor label is applied (production actions panel: “Apply Ads OS monitor labels”). Not a spend drop and not a data-fetch failure."
                            data-testid={`chip-setup-needed-${r.client}`}
                          >
                            setup needed
                          </span>
                        )}
                        {r.metrics_partial && (
                          <span
                            className="cmb-partial"
                            title="One of this client's accounts couldn't load its metrics this refresh — the totals shown are understated. Retrying automatically."
                          >
                            partial
                          </span>
                        )}
                        {/* Task #4878: per-account Paused/Off chips — always visible
                            regardless of whether budget-pacing data is available. */}
                        <CombinedMemberStatusSection members={r.members} />
                      </td>
                      <td className="dash-practice-area">
                        {practiceAreaText(r.practice_areas) || <span className="muted">—</span>}
                      </td>
                      <td className="dash-person">{r.doer ? firstName(r.doer) : <span className="muted">—</span>}</td>
                      <td className="dash-person">{r.checker ? firstName(r.checker) : <span className="muted">—</span>}</td>
                      <td className="num">
                        <MetricPill
                          value={money(r.spend_30d, c)}
                          cur={r.spend_30d}
                          prev={r.spend_prev}
                          kind="neutral"
                          title={spendTitle}
                        />
                      </td>
                      <td className="num">
                        <MetricPill
                          value={`${round1(r.leads_30d)}`}
                          cur={r.leads_30d}
                          prev={r.leads_prev}
                          kind="up-good"
                          title={leadsTitle}
                        />
                      </td>
                      <td className="num">
                        {r.cpl_30d === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <MetricPill
                            value={money(r.cpl_30d, c)}
                            cur={r.cpl_30d}
                            prev={r.cpl_prev}
                            kind="down-good"
                          />
                        )}
                      </td>
                      <td className="num">
                        <CombinedPaceCell r={r} c={c} />
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="pad">
                      {rows && rows.length > 0 ? (
                        <EmptyState
                          title="No clients match this filter"
                          description="No client matches the name, people and attention filters you've set."
                          hint="Clear the text filter or turn off “Needs attention only” to broaden the view."
                          action={
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => {
                                setFilter("");
                                setAttnOnly(false);
                              }}
                              data-testid="button-clear-combined-filter"
                            >
                              Clear filter
                            </button>
                          }
                          testId="empty-combined-filtered"
                        />
                      ) : live === false ? (
                        <EmptyState
                          title="Can't reach the client directory"
                          description="The ClickUp Client List is unavailable right now, so clients can't be listed."
                          hint="This usually clears on its own — retry in a moment."
                          action={
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={refresh}
                              disabled={loading || refreshing}
                              data-testid="button-empty-combined-retry"
                            >
                              Retry
                            </button>
                          }
                          testId="empty-combined-directory"
                        />
                      ) : (
                        <EmptyState
                          title="No active clients yet"
                          description="No active clients were found in the ClickUp Client List."
                          hint="Add a client in the ClickUp Client List and they'll appear here after the next refresh."
                          testId="empty-combined-none"
                        />
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AdsOsShell>
  );
}

/** Per-member Paused/Off status chips shown in the combined dashboard's client
 *  name cell — always visible regardless of whether budget-pacing data exists
 *  for an account (Task #4878). Exported for the jsdom render test. */
export function CombinedMemberStatusSection({ members }: { members: CombinedMember[] }) {
  const flagged = members.filter(
    (m) => m.ads_status === "paused" || m.ads_status === "off",
  );
  if (flagged.length === 0) return null;
  return (
    <span className="cmb-status-list" data-testid="cmb-status-list">
      {flagged.map((m) => (
        <span key={`${m.product}:${m.customer_id}`} className="cmb-acct-status">
          <AdsStatusChip
            status={m.ads_status as "paused" | "off"}
            check={m.status_check ?? null}
            product={m.product as "gads" | "lsa"}
            accountName={m.descriptive_name}
          />
        </span>
      ))}
    </span>
  );
}

// Combined budget-pacing pill (GAds + LSA). Color thresholds are shared with every
// dashboard via paceClass (green −5% to 0%, yellow 0 to +5% over or −5 to −15%
// behind, red above +5% over or worse than −15% behind); solid "MBH" when combined
// MTD spend has reached the combined monthly budget. A hit uses the neutral
// hit-paused treatment when every pacing contributor is paused. Clicking the pill
// drops down the totals plus each account's own pacing so it's clear what's
// over/underspending, with the reconciliation inputs behind each account's figures
// as sub-lines (Task #3897). Exported for the jsdom render test.
export function CombinedPaceCell({ r, c }: { r: CombinedDashboardRow; c: string }) {
  const p = r.pacing_pct;
  if (p === null) return <span className="muted">—</span>;
  const pacingMembers = r.members.filter(
    (m) => m.pacing_included ?? m.pacing_budget !== null,
  );
  const allMonitoredCampaignsPaused =
    pacingMembers.length > 0 &&
    pacingMembers.every((m) => m.ads_status === "paused");
  const cls = r.pacing_hit
    ? allMonitoredCampaignsPaused
      ? "hit-paused"
      : "hit"
    : paceClass(p);
  const rows: PaceRow[] = [];
  if (r.pacing_budget !== null) rows.push({ label: "Total budget", value: money(r.pacing_budget, c) });
  if (r.pacing_mtd !== null) rows.push({ label: "Total MTD spend", value: money(r.pacing_mtd, c) });
  for (const m of pacingMembers) {
    const tag = m.product === "gads" ? "GAds" : "LSA";
    const base = m.product === "lsa" && m.city ? `${tag} · ${m.city}` : tag;
    const label = m.ads_status === "off" ? `${base} · off` : base;
    const value =
      m.pacing_budget === null
        ? `No budget configured · MTD ${money(m.pacing_mtd ?? 0, c)}`
        : `${paceStr(m.pacing_pct)} · ${money(m.pacing_budget, c)} · MTD ${money(m.pacing_mtd ?? 0, c)}`;
    rows.push({
      label,
      value,
      sub: memberReconciliation(m, c),
    });
  }
  return (
    <PacePill
      cls={cls}
      text={r.pacing_hit ? "MBH" : `${p > 0 ? "+" : ""}${Math.round(p)}%`}
      note={
        r.pacing_hit
          ? allMonitoredCampaignsPaused
            ? "Monthly Budget Hit — budget reached and all monitored campaigns are paused"
            : "Monthly Budget Hit — combined MTD spend has reached the combined monthly budget"
          : null
      }
      rows={rows}
      testId={`pill-pace-${r.client.toLowerCase().replace(/\s+/g, "-")}`}
    />
  );
}

function paceStr(pct: number | null): string {
  return pct === null ? "—" : `${pct > 0 ? "+" : ""}${Math.round(pct)}%`;
}

// Task #3897: per-account reconciliation sub-lines under each member's row in
// the pill dropdown — the inputs behind the stored figures (expected-to-date,
// budget source, applied schedule + origin, last run time), so the cause of a
// disagreement with the original Ads OS app (budget mismatch, inferred
// schedule, stale run) is visible without opening each account's pacing tool.
// Fields are omitted (no line) when unknown — older store docs / cached rows.
function memberReconciliation(m: CombinedMember, c: string, now = new Date()): PaceSubLine[] {
  const sub: PaceSubLine[] = [];
  const srcLabel =
    m.pacing_budget_source === "clickup"
      ? "ClickUp"
      : m.pacing_budget_source === "sheet"
        ? "legacy budget sheet"
        : null;
  const parts: string[] = [];
  if (m.pacing_expected != null) parts.push(`Expected ${money(m.pacing_expected, c)}`);
  if (srcLabel) parts.push(`Budget from ${srcLabel}`);
  if (parts.length) sub.push({ text: parts.join(" · ") });
  if (m.pacing_schedule_days != null) {
    const sched = scheduleLabel(m.pacing_schedule_days);
    sub.push({
      text:
        m.pacing_schedule_source === "inferred"
          ? `Schedule ≈ ${sched} (inferred from recent spend)`
          : `Schedule ${sched}`,
    });
  }
  if (m.pacing_generated_at) {
    const at = new Date(m.pacing_generated_at);
    if (!Number.isNaN(at.getTime())) {
      const isToday =
        at.getFullYear() === now.getFullYear() &&
        at.getMonth() === now.getMonth() &&
        at.getDate() === now.getDate();
      const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      sub.push(
        isToday
          ? { text: `As of today ${time}` }
          : {
              text: `As of ${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time} — stale, re-run before comparing`,
              warn: true,
            },
      );
    }
  }
  return sub;
}

function splitTitle(
  label: string,
  gads: number,
  lsa: number,
  r: CombinedDashboardRow,
  c: string
): string {
  const fmt = c ? (n: number) => money(n, c) : (n: number) => round1(n).toString();
  return [
    r.has_gads ? `GAds ${label}: ${fmt(gads)}` : null,
    r.has_lsa ? `LSA ${label}: ${fmt(lsa)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function dominantCurrency(rows: CombinedDashboardRow[] | null): string {
  if (!rows) return "";
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.currency_code) counts[r.currency_code] = (counts[r.currency_code] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
