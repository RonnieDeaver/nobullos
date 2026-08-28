/**
 * Ads OS · LSA dashboard (/ads-os/lsa) — port of the bundle's
 * frontend/src/components/LsaDashboard.tsx.
 *
 * Live overlays: Budget pacing (Phase 2) and Hygiene (Phase 3 — persisted
 * audit score linking to /ads-os/lsa/a/{cid}/hygiene, plus the "Run stale
 * audits" batch button). Alerts (Phase 6) overlay live from the alerts store;
 * Refresh recomputes them first (no Slack — the morning cron owns the digest)
 * and surfaces a notice when the recompute fails or resolves zero enrolled
 * accounts (§14). Cost / Charged leads / CPL / Answer rate are live, with the
 * ClickUp city suffix on account names.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { api } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { ClickUpTaskRef, LsaDashboardRow } from "./lib/types";
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

type SortKey = "name" | "practiceAreas" | "cost" | "leads" | "cpl" | "answer" | "pacing" | "health" | "doer" | "checker";
type SortDir = "asc" | "desc";
type CachedDash = { rows: LsaDashboardRow[]; cached: boolean; live: boolean | null; staleSince?: string | null };

const LOW_ANSWER = 80; // answer rate below this is "red"

export default function LsaDashboardPage() {
  const [range, setRange] = useState<DashRange>(DEFAULT_RANGE);
  const cacheKey = `lsa:${range.window}:${range.compare}`;
  const [rows, setRows] = useState<LsaDashboardRow[] | null>(
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
  const [filter, setFilter] = useState("");
  const [doerFilter, setDoerFilter] = useStickyFilter("lsa:doer");
  const [checkerFilter, setCheckerFilter] = useStickyFilter("lsa:checker");
  const [attnOnly, setAttnOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [criteriaFor, setCriteriaFor] = useState<LsaDashboardRow | null>(null);
  // Ads OS store health from the freshest payload (Task #3706); null until a
  // live response arrives (session-cache hydrates rows only — no stale banner).
  const [storeOk, setStoreOk] = useState<boolean | null>(null);
  const [storeReason, setStoreReason] = useState<string | null>(null);
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

  function toggle(cid: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  }

  function load(force = false) {
    // Ignore out-of-order responses (a slow older range must not overwrite the newer).
    const myId = ++reqIdRef.current;
    const stale = () => myId !== reqIdRef.current;
    if (force || !readDashCache(cacheKey)) setLoading(true);
    setError(null);
    return api
      .lsaDashboard({ force, window: range.window, compare: range.compare })
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
    void load(false); // fire-and-forget: revalidate, errors handled inside
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
      const r = await api.lsaRunAlerts();
      setAlertsNote(zeroAccountNotice(r, ["lsa"]));
    } catch (e) {
      setAlertsNote(
        `Alerts recompute failed — ⚠ badges show the last stored state${
          e instanceof Error && e.message ? ` (${e.message})` : ""
        }.`
      );
    }
    // The server intentionally leaves the dashboard's force cache-bust open
    // to every authenticated staff role (see server/routes/adsOs.ts header
    // comment) — only the alerts recompute above is CEO-gated. Refresh must
    // always force a real rebuild so "cached"/"fresh" reflects reality.
    await load(true);
    setRefreshing(false);
  }

  // Per-row ClickUp binding for the expanded alert list: optimistic task refs
  // from this session win over the payload's reconciled state until reload.
  function clickupFor(cid: string): ClickUpBinding {
    return {
      enabled: cuEnabled && isCeo, // ClickUp task creation is CEO-only (Task #4977)
      taskFor: (a) => cuTasks[`lsa:${cid}:${a.code}`] ?? a.clickup_task,
      onCreate: async (a) => {
        const ref = await api.createClickupTask("lsa", cid, a.code);
        setCuTasks((m) => ({ ...m, [`lsa:${cid}:${a.code}`]: ref }));
      },
    };
  }

  // "Verify status": re-run the Paused/Off verification check and reload so
  // the ✓/✗ chips reflect the current account state without waiting for the
  // morning cron. A note surfaces when the batch was skipped so a silent
  // all-clear is distinguishable from a check that never ran.
  async function verifyStatus() {
    setVerifying(true);
    setVerifyNote(null);
    try {
      const r = await api.lsaRunStatusChecks();
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

  // "Run stale audits": batch-audit every enrolled account whose hygiene score
  // is missing or older than 7 days, then reload (the hygiene overlay is applied
  // live on every dashboard response, so a plain reload picks up fresh scores).
  async function runAudits() {
    setAuditing(true);
    setAuditNote(null);
    try {
      const r = await api.lsaRunStaleAudits();
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
    let cost = 0, costPrev = 0, leads = 0, leadsPrev = 0;
    for (const r of summaryRows) {
      cost += r.cost_30d;
      costPrev += r.cost_prev;
      leads += r.charged_leads_30d;
      leadsPrev += r.charged_leads_prev;
    }
    return {
      cost, costPrev, leads, leadsPrev, attn: countNeedsAttention(summaryRows),
      cpl: leads > 0 ? cost / leads : null,
      cplPrev: leadsPrev > 0 ? costPrev / leadsPrev : null,
    };
  }, [rows, summaryRows]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const mul = sort.dir === "asc" ? 1 : -1;
    const str = (r: LsaDashboardRow): string | null =>
      sort.key === "name" ? `${r.client_name ?? r.descriptive_name} ${r.lsa_city ?? ""}`
      : sort.key === "practiceAreas" ? practiceAreaText(r.practice_areas)
      : sort.key === "doer" ? r.doer
      : sort.key === "checker" ? r.checker
      : null;
    const num = (r: LsaDashboardRow): number | null =>
      sort.key === "cost" ? r.cost_30d
      : sort.key === "leads" ? r.charged_leads_30d
      : sort.key === "cpl" ? r.cpl_30d
      : sort.key === "answer" ? r.answer_rate_30d
      : sort.key === "pacing" ? r.pacing_pct
      : sort.key === "health" ? r.health_score
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
      const hay = `${r.client_name ?? ""} ${r.descriptive_name} ${r.lsa_city ?? ""} ${r.customer_id} ${practiceAreaText(r.practice_areas)}`.toLowerCase();
      const okQ = terms.every((t) => hay.includes(t));
      const okA = !attnOnly || needsAttention(r);
      return okQ && okA;
    });
  }, [sorted, filter, attnOnly, doerFilter, checkerFilter]);

  if (error && !rows) {
    return (
      <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
        <div className="panel error" data-testid="panel-lsa-error">
          Couldn’t load LSA accounts: {error}{" "}
          <button className="link" onClick={() => load(true)}>Retry</button>
        </div>
      </AdsOsShell>
    );
  }

  return (
    <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince} clickupBundleAgeMs={bundleAgeMs} storeOk={storeOk} storeReason={storeReason} onDirectoryRefreshed={() => load(true)}>
      <div className="dash" data-testid="page-ads-os-lsa">
        {error && rows && (
          <div className="banner banner-amber">
            Refresh failed — showing the last loaded data.{" "}
            <button className="link" onClick={() => load(true)}>Retry</button>
          </div>
        )}
        <div className="dash-head">
          <div>
            <h2>Local Services accounts</h2>
            <span className="muted">
              {rows ? `${rows.length} accounts · NBM_LSA_MONITOR` : "Loading…"}
              {rows ? ` · ${cached ? "cached" : "fresh"}` : ""}
            </span>
          </div>
        </div>

        {summary && (
          <div className="dash-summary">
            <StatTile
              val={
                <>
                  {money(summary.cost, cur)}
                  <MetricChange cur={summary.cost} prev={summary.costPrev} kind="neutral" title={cmp} />
                </>
              }
              label={`Cost · ${range.window}d`}
            />
            <StatTile
              val={
                <>
                  {round1(summary.leads)}
                  <MetricChange cur={summary.leads} prev={summary.leadsPrev} kind="up-good" title={cmp} />
                </>
              }
              label={`Charged leads · ${range.window}d`}
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
              data-testid="input-lsa-filter"
            />
            {(doers.length > 0 || checkers.length > 0) && (
              <div className="dash-people-filter">
                <select
                  className="dash-dd"
                  value={doerFilter}
                  onChange={(e) => setDoerFilter(e.target.value)}
                  aria-label="Filter by doer"
                  title="Show only accounts this person is the doer for"
                  data-testid="select-lsa-doer"
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
                  data-testid="select-lsa-checker"
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
              title="Audit every enrolled account whose hygiene score is missing or older than 7 days"
              data-testid="button-lsa-run-audits"
            >
              {auditing ? "Auditing…" : "Run stale audits"}
            </button>
            <button
              className="btn-secondary"
              onClick={verifyStatus}
              disabled={verifying || loading || refreshing}
              title="Re-run the Paused/Off verification check and update ✓/✗ status chips"
              data-testid="button-lsa-verify-status"
            >
              {verifying ? "Verifying…" : "Verify status"}
            </button>
            </>)}
            <button className="btn-secondary" onClick={refresh} disabled={loading || refreshing} data-testid="button-lsa-refresh">
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        {auditNote && (
          <div className="dash-note muted" data-testid="text-lsa-audit-note">
            {auditNote}
          </div>
        )}

        {verifyNote && (
          <div className="dash-note muted" data-testid="text-lsa-verify-note">
            {verifyNote}
          </div>
        )}

        {alertsNote && (
          <div className="banner banner-amber" data-testid="text-lsa-alerts-note">
            {alertsNote}
          </div>
        )}

        {loading && !rows ? (
          <div className="panel loading">
            <div className="spinner" />
            Pulling {range.window}-day LSA metrics for every monitored account…
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
                  <SortHeader label={`Cost ${range.window}d`} k="cost" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`Charged leads ${range.window}d`} k="leads" sort={sort} onSort={clickSort} num />
                  <SortHeader label={`CPL ${range.window}d`} k="cpl" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Answer rate" k="answer" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Budget pacing" k="pacing" sort={sort} onSort={clickSort} num />
                  <SortHeader label="Hygiene" k="health" sort={sort} onSort={clickSort} num />
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
                        data-testid={`row-lsa-${r.customer_id}`}
                      >
                        <td>
                          <span className="cmb-caret">{open ? "▾" : "▸"}</span>
                          <span className="dash-name">{r.client_name ?? r.descriptive_name}</span>
                          {r.lsa_city && <span className="dash-city">{r.lsa_city}</span>}
                          <AdsStatusChip status={r.ads_status ?? null} check={r.status_check} product="lsa" accountName={r.descriptive_name} />
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
                            value={money(r.cost_30d, c)}
                            cur={r.cost_30d}
                            prev={r.cost_prev}
                            kind="neutral"
                          />
                        </td>
                        <td className="num">
                          <MetricPill
                            value={`${round1(r.charged_leads_30d)}`}
                            cur={r.charged_leads_30d}
                            prev={r.charged_leads_prev}
                            kind="up-good"
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
                          <AnswerCell r={r} />
                        </td>
                        <td className="num">
                          <PaceCell r={r} c={c} />
                        </td>
                        <td className="num">
                          <HealthPill
                            score={r.health_score}
                            band={r.health_band}
                            at={r.health_at}
                            href={`/ads-os/lsa/a/${r.customer_id}/hygiene`}
                            testId={`pill-health-${r.customer_id}`}
                            inactiveTitle="No active Local Services campaigns in scope"
                          />
                        </td>
                      </tr>
                      {open && (
                        <tr className="cmb-detail-row">
                          <td colSpan={10}>
                            <AlertList alerts={r.alerts} clickup={clickupFor(r.customer_id)} />
                            <div className="dash-tools" onClick={(e) => e.stopPropagation()}>
                              <Link
                                href={`/ads-os/lsa/a/${r.customer_id}/hygiene`}
                                className="cmb-link"
                                data-testid={`link-hygiene-${r.customer_id}`}
                              >
                                Hygiene Audit
                              </Link>
                              <Link
                                href={`/ads-os/lsa/a/${r.customer_id}/pacing`}
                                className="cmb-link"
                                data-testid={`link-pacing-${r.customer_id}`}
                              >
                                Budget Pacing
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
                              data-testid="button-clear-lsa-filter"
                            >
                              Clear filter
                            </button>
                          }
                          testId="empty-lsa-filtered"
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
                              data-testid="button-empty-lsa-retry"
                            >
                              Retry
                            </button>
                          }
                          testId="empty-lsa-directory"
                        />
                      ) : (
                        <EmptyState
                          title="No monitored LSA accounts yet"
                          description="No LSA accounts are being monitored from the ClickUp Client List."
                          hint="Enrol an account in the ClickUp Client List and it'll appear here after the next refresh."
                          testId="empty-lsa-none"
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
              void load(false); // fire-and-forget: pacing store is refreshed on save; re-overlay it, errors handled inside
            }}
          />
        )}
      </div>
    </AdsOsShell>
  );
}

// LSA budget-pacing pill (monthly pacing, weekly recommendation). Same MBH rule
// as GAds; the paused note names the LSA since an LSA account has one "campaign".
export function PaceCell({ r, c }: { r: LsaDashboardRow; c: string }) {
  const p = r.pacing_pct;
  // Which LSA schedule the pacing figures assume ("Every day" when unset) —
  // shown in the dropdown Schedule row only (no chip next to the pill).
  const sched = scheduleLabel(r.lsa_schedule_days);
  if (p === null)
    return <span className="muted">—</span>;
  const hitBudget =
    r.monthly_budget !== null && r.mtd_spend !== null && r.mtd_spend >= r.monthly_budget;
  const hitCls = r.ads_running ? "hit" : "hit-paused";
  const cls = hitBudget ? hitCls : paceClass(p);
  const rows: PaceRow[] = [];
  if (r.monthly_budget !== null) rows.push({ label: "Monthly budget", value: money(r.monthly_budget, c) });
  if (r.mtd_spend !== null) rows.push({ label: "MTD spend", value: money(r.mtd_spend, c) });
  if (r.recommended_weekly_budget !== null)
    rows.push({ label: "Recommended weekly", value: money(r.recommended_weekly_budget, c) });
  rows.push({ label: "Schedule", value: sched });
  return (
    <PacePill
      cls={cls}
      text={hitBudget ? "MBH" : `${p > 0 ? "+" : ""}${Math.round(p)}%`}
      note={
        hitBudget
          ? r.ads_running
            ? "Monthly Budget Hit — MTD spend has reached the monthly budget"
            : "Monthly Budget Hit — budget reached and the LSA is paused"
          : null
      }
      rows={rows}
      testId={`pill-pace-${r.customer_id}`}
    />
  );
}

export function AnswerCell({ r }: { r: LsaDashboardRow }) {
  const rate = r.answer_rate_30d;
  if (rate === null) return <span className="muted">—</span>;
  const roundedRate = Math.round(rate);
  const cls = roundedRate >= 95 ? "g" : roundedRate >= LOW_ANSWER ? "w" : "b";
  const title = `${r.answer_connected_30d} connected ÷ ${r.answer_calls_30d} calls`;
  return (
    <span className={`dash-pill ${cls}`} title={title}>
      {Math.round(rate)}%
    </span>
  );
}

function dominantCurrency(rows: LsaDashboardRow[] | null): string {
  if (!rows) return "";
  const counts: Record<string, number> = {};
  for (const r of rows) if (r.currency_code) counts[r.currency_code] = (counts[r.currency_code] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}
