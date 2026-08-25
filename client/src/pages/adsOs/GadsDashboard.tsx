/**
 * Ads OS · Google Ads dashboard (/ads-os/gads) — port of the bundle's
 * frontend/src/components/Dashboard.tsx.
 *
 * Live overlays: Budget pacing (Phase 2) and Hygiene (Phase 3 — persisted
 * audit score linking to /ads-os/a/{cid}/audit, plus the "Run stale audits"
 * batch button). Later-phase columns render honest placeholders:
 *  - Traffic quality (Phase 4) reads the persisted score from every Search
 *    Term Analyzer negatives run; "—" until an account has ever been reviewed.
 *  - Alerts (Phase 6) overlay live from the alerts store (⚠ badges + the
 *    "Need attention" tile); Refresh recomputes them first — no Slack, the
 *    morning cron owns the digest — and surfaces a notice when the recompute
 *    fails or resolves zero enrolled accounts (§14).
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { api } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { ClickUpTaskRef, DashboardRow } from "./lib/types";
import { AdsStatusChip } from "./components/StatusChip";
import { MetricPill, MetricChange } from "./components/MetricPill";
import { RangeSelector, DEFAULT_RANGE, compareLabel, type DashRange } from "./components/RangeSelector";
import { readDashCache, writeDashCache } from "./lib/dashCache";
import { useStickyFilter } from "./lib/stickyFilter";
import { money, round1, formatId, firstName, distinctPeople, practiceAreaText, scheduleLabel } from "./lib/format";
import { SortHeader } from "./components/SortHeader";
import { StatTile } from "./components/StatTile";
import { AdsOsShell } from "./components/AdsOsShell";
import { AlertBadge, AlertList, type ClickUpBinding } from "./components/AlertBadge";
import { needsAttention, countNeedsAttention, zeroAccountNotice } from "./lib/alerts";
import { paceClass } from "./lib/pace";
import { PacePill, type PaceRow } from "./components/PacePill";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { HealthPill } from "./components/HealthPill";
import { EmptyState } from "@/components/kit/EmptyState";

type SortKey = "name" | "practiceAreas" | "spend" | "conv" | "cpa" | "health" | "pacing" | "quality" | "doer" | "checker";
type SortDir = "asc" | "desc";
type CachedDash = { rows: DashboardRow[]; cached: boolean; live: boolean | null; staleSince?: string | null };

export default function GadsDashboardPage() {
  const [range, setRange] = useState<DashRange>(DEFAULT_RANGE);
  const cacheKey = `gads:${range.window}:${range.compare}`;
  const [rows, setRows] = useState<DashboardRow[] | null>(
    () => readDashCache<CachedDash>(cacheKey)?.rows ?? null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !readDashCache(cacheKey));
  const [cached, setCached] = useState(() => readDashCache<CachedDash>(cacheKey)?.cached ?? false);
  const [live, setLive] = useState<boolean | null>(() => readDashCache<CachedDash>(cacheKey)?.live ?? null);
  const [staleSince, setStaleSince] = useState<string | null>(() => readDashCache<CachedDash>(cacheKey)?.staleSince ?? null);
  const [refreshing, setRefreshing] = useState(false);
  // Task #4977: non-CEO staff get a read-only Ads OS — CEO-only trigger/edit
  // controls are hidden and Refresh skips the CEO-only recompute POST.
  const isCeo = useIsCeo();

  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditNote, setAuditNote] = useState<string | null>(null);
  const [alertsNote, setAlertsNote] = useState<string | null>(null);
  const [bundleAgeMs, setBundleAgeMs] = useState<number | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  // Ads OS store health from the freshest payload (Task #3706); null until a
  // live response arrives (session-cache hydrates rows only — no stale banner).
  const [storeOk, setStoreOk] = useState<boolean | null>(null);
  const [storeReason, setStoreReason] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [doerFilter, setDoerFilter] = useStickyFilter("gads:doer");
  const [checkerFilter, setCheckerFilter] = useStickyFilter("gads:checker");
  const [attnOnly, setAttnOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [criteriaFor, setCriteriaFor] = useState<DashboardRow | null>(null);
  // ClickUp ticket wiring: whether task creation is available (token configured),
  // plus an optimistic {product}:{cid}:{code} -> task map for tickets created in
  // this session (cleared whenever a fresh payload arrives with the live state).
  const [cuEnabled, setCuEnabled] = useState(false);
  const [cuTasks, setCuTasks] = useState<Record<string, ClickUpTaskRef>>({});
  const reqIdRef = useRef(0); // latest in-flight load; older responses are ignored

  useEffect(() => {
    api
      .clickupEnabled()
      .then((r) => setCuEnabled(r.enabled))
      .catch(() => setCuEnabled(false));
  }, []);

  function load(force = false) {
    // Guard against out-of-order responses: switching the range fast fires overlapping
    // loads, and a slow older one must not overwrite the newer range's rows. Only the
    // latest load's response is applied.
    const myId = ++reqIdRef.current;
    const stale = () => myId !== reqIdRef.current;
    if (force || !readDashCache(cacheKey)) setLoading(true);
    setError(null);
    return api
      .dashboard({ force, window: range.window, compare: range.compare })
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
        setCuTasks({}); // fresh rows carry the reconciled ClickUp state
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
    void load(false); // fire-and-forget: load handles its own errors internally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  async function refresh() {
    setRefreshing(true);
    setAlertsNote(null);
    // Recompute alerts first so the reload's badges reflect right-now state.
    // A failed or zero-account recompute surfaces a non-blocking notice —
    // silently reloading would make stale stored alerts (or an empty store)
    // indistinguishable from a fresh all-clear (§14).
    // Non-CEO: skip the CEO-only recompute POST; Refresh = force reload only.
    if (isCeo) try {
      const r = await api.runAlerts();
      setAlertsNote(zeroAccountNotice(r, ["gads"]));
    } catch (e) {
      setAlertsNote(
        `Alerts recompute failed — ⚠ badges show the last stored state${
          e instanceof Error && e.message ? ` (${e.message})` : ""
        }.`
      );
    }
    // Task #4977: force reload recomputes+persists via vendor calls — CEO-only.
    // Non-CEO Refresh re-reads the stored/cached data without forcing.
    await load(isCeo);
    setRefreshing(false);
  }

  // Per-row ClickUp binding for the expanded alert list: optimistic task refs
  // from this session win over the payload's reconciled state until reload.
  function clickupFor(cid: string): ClickUpBinding {
    return {
      enabled: cuEnabled && isCeo, // ClickUp task creation is CEO-only (Task #4977)
      taskFor: (a) => cuTasks[`gads:${cid}:${a.code}`] ?? a.clickup_task,
      onCreate: async (a) => {
        const ref = await api.createClickupTask("gads", cid, a.code);
        setCuTasks((m) => ({ ...m, [`gads:${cid}:${a.code}`]: ref }));
      },
    };
  }

  // "Verify status": re-run the Paused/Off verification check and reload so
  // the ✓/✗ chips reflect the current account state without waiting for the
  // morning cron. A note surfaces when the batch was skipped (no paused/off
  // targets, directory unavailable, or every account errored) so a silent
  // all-clear is distinguishable from a check that never ran.
  async function verifyStatus() {
    setVerifying(true);
    setVerifyNote(null);
    try {
      const r = await api.runStatusChecks();
      if (r.skipped) {
        setVerifyNote(
          r.skipped === "clickup_unavailable"
            ? "Verification skipped — ClickUp directory unavailable (last batch kept)."
            : r.skipped === "no_targets"
            ? "Verification skipped — no paused/off accounts to check."
            : "Verification skipped — every account errored (last batch kept).",
        );
      } else {
        setVerifyNote(
          `Verified ${r.checked ?? 0} account${(r.checked ?? 0) === 1 ? "" : "s"}` +
            (r.mismatches ? ` · ${r.mismatches} mismatch${r.mismatches === 1 ? "" : "es"}` : "") +
            (r.errors ? ` · ${r.errors} error${r.errors === 1 ? "" : "s"}` : "") +
            (r.saved === false ? " · store write failed" : "") +
            ".",
        );
      }
      await load(true);
    } catch (e) {
      setVerifyNote(`Verify failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerifying(false);
    }
  }

  // "Run stale audits": batch-audit every monitored account whose hygiene score
  // is missing or older than 7 days, then reload (the hygiene overlay is applied
  // live on every dashboard response, so a plain reload picks up fresh scores).
  async function runAudits() {
    setAuditing(true);
    setAuditNote(null);
    try {
      const r = await api.runStaleAudits();
      setAuditNote(
        r.requested === 0
          ? "All hygiene scores are fresh (under 7 days old)."
          : `Audited ${r.ran} of ${r.requested} stale account${r.requested === 1 ? "" : "s"}.`
      );
      await load(false);
    } catch (e) {
      setAuditNote(`Audit sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAuditing(false);
    }
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
    let spend = 0, spendPrev = 0, conv = 0, convPrev = 0;
    for (const r of summaryRows) {
      spend += r.spend_30d;
      spendPrev += r.spend_prev;
      conv += r.conversions_30d;
      convPrev += r.conversions_prev;
    }
    return {
      spend, spendPrev, conv, convPrev, attn: countNeedsAttention(summaryRows),
      cpa: conv > 0 ? spend / conv : null,
      cpaPrev: convPrev > 0 ? spendPrev / convPrev : null,
    };
  }, [rows, summaryRows]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const mul = sort.dir === "asc" ? 1 : -1;
    const str = (r: DashboardRow): string | null =>
      sort.key === "name" ? (r.client_name ?? r.descriptive_name)
      : sort.key === "practiceAreas" ? practiceAreaText(r.practice_areas)
      : sort.key === "doer" ? r.doer
      : sort.key === "checker" ? r.checker
      : null;
    const num = (r: DashboardRow): number | null =>
      sort.key === "spend" ? r.spend_30d
      : sort.key === "conv" ? r.conversions_30d
      : sort.key === "cpa" ? r.cpa_30d
      : sort.key === "health" ? r.health_score
      : sort.key === "pacing" ? r.budget_pacing_pct
      : sort.key === "quality" ? r.traffic_quality
      : 0;
    const isText = sort.key === "name" || sort.key === "practiceAreas" || sort.key === "doer" || sort.key === "checker";
    return [...rows].sort((a, b) => {
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
      const hay = `${r.client_name ?? ""} ${r.descriptive_name} ${r.customer_id} ${practiceAreaText(r.practice_areas)}`.toLowerCase();
      const okQ = terms.every((t) => hay.includes(t));
      const okA = !attnOnly || needsAttention(r);
      return okQ && okA;
    });
  }, [sorted, filter, attnOnly, doerFilter, checkerFilter]);

  function toggle(cid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  }

  // Only take over the screen with the error panel when there's nothing to show. If a
  // background revalidate fails but we still have (cached) rows, keep the table and show
  // a dismissible banner instead of a dead end.
  if (error && !rows) {
    return (
      <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
        <div className="panel error" data-testid="panel-gads-error">
          Couldn’t load accounts: {error}{" "}
          <button className="link" onClick={() => load(isCeo)}>Retry</button>
        </div>
      </AdsOsShell>
    );
  }

  return (
    <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
      <div className="dash" data-testid="page-ads-os-gads">
        {error && rows && (
          <div className="banner banner-amber">
            Refresh failed — showing the last loaded data.{" "}
            <button className="link" onClick={() => load(isCeo)}>Retry</button>
          </div>
        )}
        <div className="dash-head">
          <div>
            <h2>Monitored accounts</h2>
            <span className="muted">
              {rows ? `${rows.length} accounts · Ads monitor` : "Loading…"}
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
                  {round1(summary.conv)}
                  <MetricChange cur={summary.conv} prev={summary.convPrev} kind="up-good" title={cmp} />
                </>
              }
              label={`Conversions · ${range.window}d`}
            />
            <StatTile
              val={
                summary.cpa === null ? (
                  "—"
                ) : (
                  <>
                    {money(summary.cpa, cur)}
                    <MetricChange cur={summary.cpa} prev={summary.cpaPrev} kind="down-good" title={cmp} />
                  </>
                )
              }
              label={`Blended CPA · ${range.window}d`}
            />
            <StatTile val={summaryRows.length} label="Accounts" />
            <StatTile val={summary.attn} label="Need attention" attn pressed={attnOnly} onClick={() => setAttnOnly((v) => !v)} testId="button-stat-need-attention" />
          </div>
        )}

        <div className="dash-bar">
          <div className="dash-bar-left">
            <input
              className="dash-filter"
              placeholder="Filter accounts by name or ID…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter accounts"
              data-testid="input-gads-filter"
            />
            {(doers.length > 0 || checkers.length > 0) && (
              <div className="dash-people-filter">
                <select
                  className="dash-dd"
                  value={doerFilter}
                  onChange={(e) => setDoerFilter(e.target.value)}
                  aria-label="Filter by doer"
                  title="Show only accounts this person is the doer for"
                  data-testid="select-gads-doer"
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
                  title="Show only accounts this person is the checker for"
                  data-testid="select-gads-checker"
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
              onClick={() => setAttnOnly((v) => !v)}
              title="Show only accounts with critical or high alerts"
              data-testid="toggle-needs-attention"
            >
              <span className="sw" /> Needs attention only
            </button>
          </div>
          <div className="dash-bar-right">
            <RangeSelector range={range} onChange={setRange} disabled={loading || refreshing} />
            {isCeo && (<>
            <button
              className="btn-secondary"
              onClick={runAudits}
              disabled={auditing || loading || refreshing}
              title="Audit every monitored account whose hygiene score is missing or older than 7 days"
              data-testid="button-run-audits"
            >
              {auditing ? "Auditing…" : "Run stale audits"}
            </button>
            <button
              className="btn-secondary"
              onClick={verifyStatus}
              disabled={verifying || loading || refreshing}
              title="Re-run the Paused/Off verification check and update ✓/✗ status chips"
              data-testid="button-gads-verify-status"
            >
              {verifying ? "Verifying…" : "Verify status"}
            </button>
            </>)}
            <button className="btn-secondary" onClick={refresh} disabled={loading || refreshing} data-testid="button-gads-refresh">
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {auditNote && (
          <div className="dash-note muted" data-testid="text-audit-note">
            {auditNote}
          </div>
        )}

        {verifyNote && (
          <div className="dash-note muted" data-testid="text-gads-verify-note">
            {verifyNote}
          </div>
        )}

        {alertsNote && (
          <div className="banner banner-amber" data-testid="text-gads-alerts-note">
            {alertsNote}
          </div>
        )}

        {loading && !rows ? (
          <div className="panel loading">
            <div className="spinner" />
            Pulling {range.window}-day metrics for every monitored account…
          </div>
        ) : (
          <div className="ki-table-wrap dash-table-wrap">
            <table className="ki-table dash-table">
              <thead>
                <tr>
                  <SortHeader label="Account" k="name" sort={sort} onSort={clickSort} />
                  <SortHeader label="Practice Area" k="practiceAreas" sort={sort} onSort={clickSort} />
                  <SortHeader label="Doer" k="doer" sort={sort} onSort={clickSort} />
                  <SortHeader label="Checker" k="checker" sort={sort} onSort={clickSort} />
                  <SortHeader label={`Spend ${range.window}d`} k="spend" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`Conv ${range.window}d`} k="conv" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`CPA ${range.window}d`} k="cpa" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Hygiene" k="health" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Budget pacing" k="pacing" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Traffic quality" k="quality" sort={sort} onSort={clickSort} num />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const c = r.currency_code ?? "";
                  const attn = needsAttention(r);
                  const open = expanded.has(r.customer_id);
                  return (
                    <Fragment key={r.customer_id}>
                      <tr
                        className={`dash-row${attn ? " row-attn" : ""}`}
                        onClick={() => toggle(r.customer_id)}
                        tabIndex={0}
                        role="button"
                        aria-expanded={open}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle(r.customer_id);
                          }
                        }}
                        data-testid={`row-gads-${r.customer_id}`}
                      >
                        <td>
                          <span className="cmb-caret">{open ? "▾" : "▸"}</span>
                          <span className="dash-name">{r.client_name ?? r.descriptive_name}</span>
                          <AdsStatusChip status={r.ads_status ?? null} check={r.status_check} product="gads" accountName={r.descriptive_name} />
                          <AlertBadge alerts={r.alerts} alertsAt={r.alerts_at} />
                          <span className="dash-id">{formatId(r.customer_id)}</span>
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
                          />
                        </td>
                        <td className="num">
                          <MetricPill
                            value={`${round1(r.conversions_30d)}`}
                            cur={r.conversions_30d}
                            prev={r.conversions_prev}
                            kind="up-good"
                          />
                        </td>
                        <td className="num">
                          {r.cpa_30d === null ? (
                            <span className="muted">—</span>
                          ) : (
                            <MetricPill
                              value={money(r.cpa_30d, c)}
                              cur={r.cpa_30d}
                              prev={r.cpa_prev}
                              kind="down-good"
                            />
                          )}
                        </td>
                        <td className="num">
                          <HealthPill
                            score={r.health_score}
                            band={r.health_band}
                            at={r.health_at}
                            href={`/ads-os/a/${r.customer_id}/audit`}
                            testId={`pill-health-${r.customer_id}`}
                          />
                        </td>
                        <td className="num">
                          <PaceCell r={r} c={c} />
                        </td>
                        <td className="num">
                          <Quality r={r} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="cmb-detail-row">
                          <td colSpan={10}>
                            <AlertList alerts={r.alerts} clickup={clickupFor(r.customer_id)} />
                            <div className="dash-tools" onClick={(e) => e.stopPropagation()}>
                              <Link
                                href={`/ads-os/a/${r.customer_id}/audit`}
                                className="cmb-link"
                                data-testid={`link-audit-${r.customer_id}`}
                              >
                                Hygiene Audit
                              </Link>
                              <Link
                                href={`/ads-os/a/${r.customer_id}/analyzer`}
                                className="cmb-link"
                                data-testid={`link-analyzer-${r.customer_id}`}
                              >
                                Search Term Analyzer
                              </Link>
                              <Link
                                href={`/ads-os/a/${r.customer_id}/pacing`}
                                className="cmb-link"
                                data-testid={`link-pacing-${r.customer_id}`}
                              >
                                Budget Pacing
                              </Link>
                              <Link
                                href={`/ads-os/a/${r.customer_id}/pyramid`}
                                className="cmb-link"
                                data-testid={`link-pyramid-${r.customer_id}`}
                              >
                                Pyramid Breakdown
                              </Link>
                              <button
                                className="cmb-link"
                                onClick={() => setCriteriaFor(r)}
                                data-testid={`button-criteria-${r.customer_id}`}
                              >
                                Client criteria
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={10} className="pad">
                      {rows && rows.length > 0 ? (
                        <EmptyState
                          title="No accounts match this filter"
                          description="No account matches the name and people filters you've set."
                          hint="Clear the filter to see every monitored account again."
                          action={
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={() => setFilter("")}
                              data-testid="button-clear-gads-filter"
                            >
                              Clear filter
                            </button>
                          }
                          testId="empty-gads-filtered"
                        />
                      ) : live === false ? (
                        <EmptyState
                          title="Can't reach the client directory"
                          description="The ClickUp Client List is unavailable right now, so accounts can't be listed."
                          hint="This usually clears on its own — retry in a moment."
                          action={
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={refresh}
                              disabled={loading || refreshing}
                              data-testid="button-empty-gads-retry"
                            >
                              Retry
                            </button>
                          }
                          testId="empty-gads-directory"
                        />
                      ) : (
                        <EmptyState
                          title="No monitored Google Ads accounts yet"
                          description="No Google Ads accounts are being monitored from the ClickUp Client List."
                          hint="Enrol an account in the ClickUp Client List and it'll appear here after the next refresh."
                          testId="empty-gads-none"
                        />
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {criteriaFor && (
          <CriteriaEditor
            account={{ customer_id: criteriaFor.customer_id, descriptive_name: criteriaFor.descriptive_name }}
            onClose={() => setCriteriaFor(null)}
            onSaved={() => {
              setCriteriaFor(null);
              void load(false); // fire-and-forget: load handles its own errors internally — pacing store is refreshed on save; re-overlay it
            }}
          />
        )}
      </div>
    </AdsOsShell>
  );
}

// Budget-pacing pill from the Phase 2 store overlay. MBH (MTD spend has reached
// the monthly budget) stands out: dark-red when ads are still running, dark-grey
// ("hit-paused") when the budget was hit but all monitored campaigns are paused.
// Traffic-quality pill (Phase 4): persisted by every Search Term Analyzer
// negatives run, surfaced by the dashboard's live overlay. Green ≥90, amber
// 70–89, red <70 (bundle Dashboard.tsx Quality).
function Quality({ r }: { r: DashboardRow }) {
  if (r.traffic_quality === null) {
    return (
      <span
        className="muted"
        title="No search-term review yet — open the account's Search Term Analyzer."
      >
        —
      </span>
    );
  }
  const q = r.traffic_quality;
  const cls = q >= 90 ? "g" : q >= 70 ? "w" : "b";
  const title = [
    r.quality_window ? `Window: last ${r.quality_window} days` : null,
    r.quality_at ? `Computed ${freshLabel(r.quality_at)}` : null,
    r.quality_coverage !== null
      ? `Coverage: ${Math.round(r.quality_coverage)}% of keyword spend reported at term level`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`dash-pill ${cls}`} title={title} data-testid={`pill-quality-${r.customer_id}`}>
      {Math.round(q)}%
    </span>
  );
}

function ageDays(at: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 86400000));
}
function freshLabel(at: string): string {
  const d = ageDays(at);
  return d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`;
}

export function PaceCell({ r, c }: { r: DashboardRow; c: string }) {
  const p = r.budget_pacing_pct;
  // Task #3682: which GAds schedule the pacing figures assume ("Every day" when
  // unset). Schedule is surfaced in the pill tooltip's "Schedule" row.
  const sched = scheduleLabel(r.schedule_days);
  if (p === null) {
    // Task #3706: budget present + the last pacing run says ZERO scheduled
    // days have elapsed → the month simply hasn't started for this schedule
    // (e.g. weekday-only account on an opening weekend). Neutral chip, not an
    // indistinguishable "—". Older docs without the field stay "—".
    const notStarted = r.monthly_budget !== null && r.scheduled_days_elapsed === 0;
    return (
      <>
        {notStarted ? (
          <span
            className="dash-notstarted"
            title="No scheduled ad days have elapsed yet this month — pacing appears after the first scheduled day completes"
            data-testid={`chip-notstarted-${r.customer_id}`}
          >
            Not started
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </>
    );
  }
  const hitBudget =
    r.monthly_budget !== null && r.mtd_spend !== null && r.mtd_spend >= r.monthly_budget;
  const hitCls = r.ads_running ? "hit" : "hit-paused";
  const cls = hitBudget ? hitCls : paceClass(p);
  const rows: PaceRow[] = [];
  if (r.monthly_budget !== null) rows.push({ label: "Monthly budget", value: money(r.monthly_budget, c) });
  if (r.mtd_spend !== null) rows.push({ label: "MTD spend", value: money(r.mtd_spend, c) });
  if (r.recommended_daily_budget !== null)
    rows.push({ label: "Recommended daily", value: money(r.recommended_daily_budget, c) });
  rows.push({ label: "Schedule", value: sched });
  const pill = (
    <PacePill
      cls={cls}
      text={hitBudget ? "MBH" : `${p > 0 ? "+" : ""}${Math.round(p)}%`}
      note={
        hitBudget
          ? r.ads_running
            ? "Monthly Budget Hit — MTD spend has reached the monthly budget"
            : "Monthly Budget Hit — budget reached and all monitored campaigns are paused"
          : null
      }
      rows={rows}
      testId={`pill-pace-${r.customer_id}`}
    />
  );
  return pill;
}

function dominantCurrency(rows: DashboardRow[] | null): string {
  if (!rows) return "";
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.currency_code) counts[r.currency_code] = (counts[r.currency_code] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
