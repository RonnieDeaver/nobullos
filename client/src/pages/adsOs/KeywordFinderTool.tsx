/**
 * Ads OS · Search Term Analyzer — New Keywords
 * (/ads-os/a/{cid}/analyzer/keywords) — port of the bundle's
 * frontend/src/components/KeywordFinder.tsx.
 *
 * NoBull OS adaptation: the CID comes from the wouter route and the header
 * name resolves best-effort from the monitored-accounts list (the report
 * itself carries account_name, so an unresolved list never blocks the tool).
 * Auto-runs on open (1h server cache); Re-run forces a fresh scan.
 */

import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import { money, round1, formatId } from "./lib/format";
import { KEYWORD_CSV_HEADERS, bareKeyword, downloadCsv, matchTypeLabel, serializeCsv, slug } from "./lib/adsEditorCsv";
import type { KeywordFinderReport, KeywordSuggestion } from "./lib/types";
import { SortHeader, type SortDir } from "./components/SortHeader";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { AnalyzerModeTabs } from "./components/AnalyzerModeTabs";

// Sortable columns for the new-keywords table. "orig" = the report's own order
// (default). Numeric columns sort descending on first click; text ascending.
type KwSortKey =
  | "orig" | "keyword" | "campaign" | "adgroup"
  | "conv" | "cost" | "cpa" | "campavg" | "why";
const KW_NUM_KEYS = new Set<KwSortKey>(["conv", "cost", "cpa", "campavg"]);

export default function KeywordFinderToolPage() {
  const [, params] = useRoute("/ads-os/a/:cid/analyzer/keywords");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Task #4977: gates CEO-only edit/action controls
  const [report, setReport] = useState<KeywordFinderReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [lookback, setLookback] = useState(30);
  const [acted, setActed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: KwSortKey; dir: SortDir }>({ key: "orig", dir: "asc" });
  const [accountName, setAccountName] = useState<string | null>(null);

  function load(days: number, force = false) {
    setLoading(true);
    setError(null);
    api
      .keywordFinder(cid, { lookbackDays: days, force })
      .then((r) => {
        setReport(r);
        setActed(new Set());
        setSelected(new Set()); // indices are report-specific — drop stale selection
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setReport(null);
    setLookback(30);
    load(30);
    // Best-effort name resolution for the header while the scan computes.
    api
      .monitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) setAccountName(a.descriptive_name);
      })
      .catch(() => {}); // header falls back to the report's own account_name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  function toggleActed(searchTerm: string, added: boolean) {
    setActed((prev) => {
      const next = new Set(prev);
      added ? next.add(searchTerm) : next.delete(searchTerm);
      return next;
    });
    api.markKeywordActioned(cid, searchTerm, !added).catch(() => {});
  }

  function changeRange(days: number) {
    setLookback(days);
    load(days);
  }

  function copy(text: string, key: string) {
    void navigator.clipboard?.writeText(text).then(() => { // fire-and-forget: clipboard write
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    }).catch((err) => console.error("[KeywordFinderTool] copy failed:", err));
  }

  function toggleSelect(idx: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function toggleAll() {
    const all = report?.suggestions ?? [];
    setSelected((prev) => (prev.size === all.length ? new Set() : new Set(all.map((_, i) => i))));
  }

  function copySelected() {
    if (!report) return;
    const picked = report.suggestions.filter((_, i) => selected.has(i)).map((s) => s.keyword);
    if (picked.length) copy(picked.join("\n"), "__selected__");
  }

  // Selected new keywords → Google Ads Editor CSV, scoped to ad-group level
  // (Campaign + Ad Group filled). Match type is its own column with bare text.
  function downloadSelectedCsv() {
    if (!report) return;
    const picked = report.suggestions.filter((_, i) => selected.has(i));
    if (!picked.length) return;
    const rows = picked.map((s) => [
      s.campaign,
      s.ad_group,
      bareKeyword(s.keyword, s.match_type),
      matchTypeLabel(s.match_type),
    ]);
    downloadCsv(`${slug(report.account_name)}-keywords.csv`, serializeCsv(KEYWORD_CSV_HEADERS, rows));
  }

  function clickSort(key: KwSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: KW_NUM_KEYS.has(key) ? "desc" : "asc" },
    );
  }

  // Suggestions paired with their ORIGINAL index, then sorted for display, so
  // sorting never disturbs which rows are checked or marked added.
  const ordered = useMemo(() => {
    const withIdx = (report?.suggestions ?? []).map((s, i) => ({ s, i }));
    if (sort.key === "orig") return withIdx;
    const mul = sort.dir === "asc" ? 1 : -1;
    const numeric = KW_NUM_KEYS.has(sort.key);
    const val = (s: KeywordSuggestion): string | number => {
      switch (sort.key) {
        case "keyword": return s.keyword;
        case "campaign": return s.campaign;
        case "adgroup": return s.ad_group;
        case "conv": return s.conversions;
        case "cost": return s.cost;
        case "cpa": return s.cpa;
        case "campavg": return s.campaign_cpa;
        case "why": return s.reason;
        default: return "";
      }
    };
    return [...withIdx].sort((a, b) => {
      const av = val(a.s), bv = val(b.s);
      if (numeric) return mul * ((av as number) - (bv as number));
      const as = String(av).toLowerCase(), bs = String(bv).toLowerCase();
      if (!as && !bs) return 0;
      if (!as) return 1;   // blanks sort last regardless of direction
      if (!bs) return -1;
      return mul * as.localeCompare(bs);
    });
  }, [report, sort]);

  const name = accountName ?? report?.account_name ?? formatId(cid);
  const cur = report?.currency_code ?? "";
  // Guarded (?? []) so a stale pre-feature payload during a rolling deploy can't crash the page.
  const conflicts = report?.conflicts ?? [];
  // Held-back rows the user dismissed this session (via the actioned store) drop out visually
  // right away; the server hides them entirely on the next load.
  const visibleConflicts = conflicts.filter((s) => !acted.has(s.search_term));

  return (
    <AdsOsShell>
      <div className="report ki" data-testid="page-ads-os-analyzer-keywords">
        <Breadcrumbs
          view="analyzer"
          analyzerSub="/keywords"
          account={{ customer_id: cid, descriptive_name: name }}
        />
        <AnalyzerModeTabs cid={cid} activeMode="keywords" />
        <div
          id="analyzer-mode-panel"
          role="tabpanel"
          aria-labelledby="analyzer-mode-tab-keywords"
        >
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">
              New keywords · {formatId(cid)}
              {report ? ` · last ${report.lookback_days} days · ${report.from_cache ? "cached" : "fresh"}` : ""}
              {report?.eligible ? ` · ${report.monitored_campaigns} labeled campaign(s)` : ""}
            </span>
          </div>
          <div className="report-actions">
            <select
              className="ki-range"
              value={lookback}
              onChange={(e) => changeRange(Number(e.target.value))}
              disabled={loading}
              aria-label="Date range"
              data-testid="select-kw-range"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
            </select>
            {/* Task #4977: force-refresh recomputes + persists via vendor/AI
                calls — CEO-only trigger, hidden for read-only staff. */}
            {isCeo && (
            <button
              className="btn-secondary"
              onClick={() => load(lookback, true)}
              disabled={loading}
              data-testid="button-rerun-keywords"
            >
              Re-run
            </button>
            )}
          </div>
        </div>

        {loading && (
          <div className="panel loading">
            <div className="spinner" />
            Finding converting terms for <strong>{name}</strong>…
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-keywords-error">{error}</div>
        )}

        {!loading && !error && report && !report.eligible && (
          <div className="panel ki-notenrolled">
            <strong>Not enrolled in Search Term Analyzer</strong>
            <div className="muted" style={{ marginTop: 8 }}>{report.scope_note}</div>
          </div>
        )}

        {!loading && !error && report && report.eligible && (
          <>
            <div className="ki-summary">
              <Stat label="Suggested keywords" value={report.suggestions.length} />
              {visibleConflicts.length > 0 && <Stat label="Held back" value={visibleConflicts.length} />}
              <Stat label="Converting terms" value={report.converting_terms} />
              <div className="ki-hint" style={{ background: "var(--track)", color: "var(--muted-ink)" }}>
                Rule: a converting term at or below its campaign's average cost/conversion, not already a keyword.
                {report.actioned_hidden > 0 && (
                  <> · {report.actioned_hidden} already added (hidden).</>
                )}
                {(report.account_blocked ?? 0) > 0 && (
                  <> · {report.account_blocked} blocked by the account's own negative keywords (hidden).</>
                )}
              </div>
            </div>

            {report.warnings.length > 0 && (
              <div className="banner banner-amber" data-testid="banner-keywords-warnings">
                {report.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            {report.suggestions.length === 0 ? (
              <div className="panel">
                {visibleConflicts.length > 0 ? (
                  <>
                    {visibleConflicts.length === 1
                      ? "1 converting term qualifies on the numbers, but it was held back"
                      : `${visibleConflicts.length} converting terms qualify on the numbers, but all were held back`}{" "}
                    — see the clash with the negatives review below.
                  </>
                ) : (
                  <>No converting terms beat their campaign's average CPA in the last {report.lookback_days} days.</>
                )}
              </div>
            ) : (
              <div className="ki-table-card">
                <div className="ki-table-head">
                  <span className="muted">
                    Paste-ready — these are suggested as <strong>phrase</strong> match.
                  </span>
                  <div className="ki-table-actions">
                    <button className="btn-secondary" onClick={toggleAll} data-testid="button-select-all">
                      {selected.size === report.suggestions.length ? "Clear selection" : "Select all"}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={copySelected}
                      disabled={selected.size === 0}
                      data-testid="button-copy-selected"
                    >
                      {copied === "__selected__"
                        ? "Copied!"
                        : `Copy selected${selected.size ? ` (${selected.size})` : ""}`}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={downloadSelectedCsv}
                      disabled={selected.size === 0}
                      data-testid="button-download-csv"
                    >
                      Download CSV{selected.size ? ` (${selected.size})` : ""}
                    </button>
                  </div>
                </div>
                <div className="ki-table-scroll">
                <table className="ki-table ki-table-kw">
                  <thead>
                    <tr>
                      <th className="ki-check">
                        <input
                          type="checkbox"
                          aria-label="Select all keywords"
                          checked={selected.size === report.suggestions.length}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                selected.size > 0 && selected.size < report.suggestions.length;
                          }}
                          onChange={toggleAll}
                        />
                      </th>
                      <SortHeader label="Suggested keyword" k="keyword" sort={sort} onSort={clickSort} />
                      <SortHeader label="Campaign" k="campaign" sort={sort} onSort={clickSort} />
                      <SortHeader label="Ad group" k="adgroup" sort={sort} onSort={clickSort} />
                      <SortHeader label="Conv." k="conv" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Cost" k="cost" sort={sort} onSort={clickSort} num />
                      <SortHeader label="CPA" k="cpa" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Camp. avg" k="campavg" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Why" k="why" sort={sort} onSort={clickSort} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map(({ s, i }) => (
                      <Row
                        key={i}
                        s={s}
                        cur={cur}
                        copied={copied}
                        onCopy={copy}
                        idx={i}
                        acted={acted.has(s.search_term)}
                        onToggleActed={toggleActed}
                        canAct={isCeo}
                        selected={selected.has(i)}
                        onToggle={toggleSelect}
                      />
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {visibleConflicts.length > 0 && (
              <div className="ki-conflicts" data-testid="section-held-back">
                <div className="ki-conflicts-head">
                  <strong>
                    ⚠ Held back — clashes with the negatives review ({visibleConflicts.length})
                  </strong>
                  <div className="muted">
                    These converting terms qualify on the numbers, but the Negative Keywords tool has a
                    pending suggestion that would block them
                    {report.negatives_generated_at
                      ? ` (reviewed ${new Date(report.negatives_generated_at).toLocaleDateString()}${
                          report.negatives_window_days ? ` · ${report.negatives_window_days}-day window` : ""
                        })`
                      : ""}
                    . If one is actually good business, update the client criteria (usually the service
                    area) and re-run the negatives tool — the keyword will reappear here. Dismiss hides a
                    row you've decided not to act on.
                  </div>
                </div>
                <div className="ki-table-scroll">
                  <table className="ki-table ki-table-kw">
                    <thead>
                      <tr>
                        <th>Keyword suggestion</th>
                        <th>Blocked by negative</th>
                        <th>Category</th>
                        <th>Negatives review says</th>
                        <th className="num">Conv.</th>
                        <th className="num">CPA</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleConflicts.map((s, i) => (
                        <tr key={i}>
                          <td><code className="ki-conflict-kw">{s.keyword}</code></td>
                          <td><code>{s.blocked_by}</code></td>
                          <td>
                            <span className="ki-cat">{(s.blocked_category ?? "").replace(/_/g, " ")}</span>
                          </td>
                          <td className="ki-why">{s.blocked_reason}</td>
                          <td className="num">{round1(s.conversions)}</td>
                          <td className="num">{money(s.cpa, cur)}</td>
                          <td className="num">
                            {isCeo && (
                            <button
                              className="dash-run"
                              onClick={() => toggleActed(s.search_term, true)}
                              data-testid={`button-dismiss-${i}`}
                            >
                              Dismiss
                            </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </AdsOsShell>
  );
}

function Row({
  s,
  cur,
  copied,
  onCopy,
  idx,
  acted,
  onToggleActed,
  canAct,
  selected,
  onToggle,
}: {
  s: KeywordSuggestion;
  cur: string;
  copied: string | null;
  onCopy: (t: string, k: string) => void;
  idx: number;
  acted: boolean;
  onToggleActed: (searchTerm: string, added: boolean) => void;
  /** Task #4977: keyword actioning is CEO-only — hides the Mark added/undo controls. */
  canAct: boolean;
  selected: boolean;
  onToggle: (idx: number) => void;
}) {
  const key = `k${idx}`;
  return (
    <tr className={[acted ? "kw-acted" : "", selected ? "ki-row-sel" : ""].filter(Boolean).join(" ")}>
      <td className="ki-check">
        <input
          type="checkbox"
          aria-label={`Select ${s.keyword}`}
          checked={selected}
          onChange={() => onToggle(idx)}
        />
      </td>
      <td>
        <button className="ki-neg" title="Click to copy" onClick={() => onCopy(s.keyword, key)}>
          <code>{s.keyword}</code>
          <span className="ki-copy">{copied === key ? "✓" : "⧉"}</span>
        </button>
      </td>
      <td className="ki-src" title={s.campaign}>{s.campaign}</td>
      <td className="ki-src" title={s.ad_group}>{s.ad_group}</td>
      <td className="num">{round1(s.conversions)}</td>
      <td className="num">{money(s.cost, cur)}</td>
      <td className="num">{money(s.cpa, cur)}</td>
      <td className="num">{money(s.campaign_cpa, cur)}</td>
      <td className="ki-why">{s.reason}</td>
      <td className="num">
        {acted ? (
          <span className="kw-done">
            Added{canAct && <> <button className="dash-run" onClick={() => onToggleActed(s.search_term, false)}>undo</button></>}
          </span>
        ) : canAct ? (
          <button className="dash-run" onClick={() => onToggleActed(s.search_term, true)}>
            Mark added
          </button>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ki-stat">
      <div className="ki-stat-val">{value}</div>
      <div className="ki-stat-label">{label}</div>
    </div>
  );
}
