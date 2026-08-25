/**
 * Ads OS · Search Term Analyzer — Negative Keywords
 * (/ads-os/a/{cid}/analyzer/negatives) — port of the bundle's
 * frontend/src/components/KeywordIntel.tsx.
 *
 * NoBull OS adaptation: the CID comes from the wouter route and the header
 * name resolves best-effort from the monitored-accounts list (the report
 * itself carries account_name, so an unresolved list never blocks the tool).
 * Auto-runs on open (1h server cache); Re-run forces a fresh review.
 */

import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { KeywordIntelReport, NegativeSuggestion } from "./lib/types";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { money, round1, formatId } from "./lib/format";
import { CAMPAIGN_NEGATIVE, NEGATIVE_CSV_HEADERS, downloadCsv, serializeCsv, slug } from "./lib/adsEditorCsv";
import { SortHeader, type SortDir } from "./components/SortHeader";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { AnalyzerModeTabs } from "./components/AnalyzerModeTabs";

// Sortable columns for the negatives table. "orig" = the report's own order (the
// default, so the view is unchanged until a header is clicked). Numeric columns
// sort descending on first click; text columns ascending.
type NegSortKey =
  | "orig" | "negative" | "match" | "category" | "term"
  | "campaign" | "adgroup" | "cost" | "clicks" | "conv" | "conf" | "why";
const NEG_NUM_KEYS = new Set<NegSortKey>(["cost", "clicks", "conv", "conf"]);

export default function KeywordIntelToolPage() {
  const [, params] = useRoute("/ads-os/a/:cid/analyzer/negatives");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<KeywordIntelReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [lookback, setLookback] = useState(7);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [csvOpen, setCsvOpen] = useState(false);
  const [sort, setSort] = useState<{ key: NegSortKey; dir: SortDir }>({ key: "orig", dir: "asc" });
  const [accountName, setAccountName] = useState<string | null>(null);

  function load(days: number, force = false) {
    setLoading(true);
    setError(null);
    api
      .keywordIntel(cid, { lookbackDays: days, force })
      .then((r) => {
        setReport(r);
        setSelected(new Set()); // indices are report-specific — drop stale selection
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  // A new account always resets to the default 7-day window, then loads.
  useEffect(() => {
    setReport(null);
    setLookback(7);
    load(7);
    // Best-effort name resolution for the header while the review computes.
    api
      .monitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) setAccountName(a.descriptive_name);
      })
      .catch(() => {}); // header falls back to the report's own account_name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  function changeRange(days: number) {
    setLookback(days);
    load(days);
  }

  function copy(text: string, key: string) {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    }).catch((err) => console.error("[KeywordIntelTool] clipboard write failed:", err)); // fire-and-forget: clipboard copy only
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
    const picked = report.suggestions.filter((_, i) => selected.has(i)).map((s) => s.negative);
    if (picked.length) copy(picked.join("\n"), "__selected__");
  }

  // Distinct campaigns that appear across the whole analysis — the target set for
  // the "all campaigns" CSV scope.
  const analysisCampaigns = useMemo(
    () => (report ? Array.from(new Set(report.suggestions.map((s) => s.campaign).filter(Boolean))) : []),
    [report],
  );

  function clickSort(key: NegSortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: NEG_NUM_KEYS.has(key) ? "desc" : "asc" },
    );
  }

  // Suggestions paired with their ORIGINAL index, then sorted for display. The
  // original index is what selection/copy/CSV key off, so sorting the view never
  // disturbs which rows are checked.
  const ordered = useMemo(() => {
    const withIdx = (report?.suggestions ?? []).map((s, i) => ({ s, i }));
    if (sort.key === "orig") return withIdx;
    const mul = sort.dir === "asc" ? 1 : -1;
    const numeric = NEG_NUM_KEYS.has(sort.key);
    const val = (s: NegativeSuggestion): string | number => {
      switch (sort.key) {
        case "negative": return s.negative;
        case "match": return s.match_type;
        case "category": return s.category;
        case "term": return s.search_term;
        case "campaign": return s.campaign;
        case "adgroup": return s.ad_group;
        case "cost": return s.cost;
        case "clicks": return s.clicks;
        case "conv": return s.conversions;
        case "conf": return s.confidence;
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

  // Selected negatives → Google Ads Editor CSV as CAMPAIGN-level negatives. The
  // file has no Ad Group column (negatives are never ad-group-scoped): columns are
  // Campaign, Keyword, Criterion Type = "Campaign negative". The match type rides
  // in s.negative's text (broad = plain, "phrase", [exact]) since the column holds
  // the negative marker.
  //  • "own": each negative applied to the campaign it was found in.
  //  • "all": each negative applied to every campaign in the analysis.
  function downloadSelectedCsv(scope: "own" | "all") {
    if (!report) return;
    const picked = report.suggestions.filter((_, i) => selected.has(i));
    if (!picked.length) return;
    const rows: string[][] = [];
    for (const s of picked) {
      const targets = scope === "all" ? analysisCampaigns : [s.campaign].filter(Boolean);
      for (const campaign of targets) rows.push([campaign, s.negative, CAMPAIGN_NEGATIVE]);
    }
    const suffix = scope === "all" ? "all-campaigns" : "own-campaign";
    downloadCsv(`${slug(report.account_name)}-negatives-${suffix}.csv`, serializeCsv(NEGATIVE_CSV_HEADERS, rows));
    setCsvOpen(false);
  }

  const name = accountName ?? report?.account_name ?? formatId(cid);
  const cur = report?.currency_code ?? "";

  return (
    <AdsOsShell>
      <div className="report ki" data-testid="page-ads-os-analyzer-negatives">
        <Breadcrumbs
          view="analyzer"
          analyzerSub="/negatives"
          account={{ customer_id: cid, descriptive_name: name }}
        />
        <AnalyzerModeTabs cid={cid} activeMode="negatives" />
        <div
          id="analyzer-mode-panel"
          role="tabpanel"
          aria-labelledby="analyzer-mode-tab-negatives"
        >
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">
              Negative keywords · {formatId(cid)}
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
              data-testid="select-ki-range"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
            </select>
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
              onClick={() => load(lookback, true)}
              disabled={loading}
              data-testid="button-rerun-negatives"
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
              load(lookback, isCeo);
            }}
          />
        )}

        {csvOpen && (
          <NegativeCsvDialog
            count={selected.size}
            campaignCount={analysisCampaigns.length}
            onPick={downloadSelectedCsv}
            onClose={() => setCsvOpen(false)}
          />
        )}

        {loading && (
          <div className="panel loading">
            <div className="spinner" />
            Reviewing search terms for <strong>{name}</strong>…
            <div className="muted">Pulling last {lookback} days, applying the safety filter & asking the model</div>
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-negatives-error">
            {error}
            {error.toLowerCase().includes("openai") && (
              <div className="muted" style={{ marginTop: 8 }}>
                Set <code>OPENAI_API_KEY</code> in the environment / Secret Manager to enable suggestions.
              </div>
            )}
          </div>
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
              <Stat label="Suggested negatives" value={report.suggestions.length} />
              <Stat label="Waste terms" value={report.waste_terms} />
              <Stat label="Wasted spend" value={money(report.wasted_spend, cur)} />
              <Stat
                label="Traffic quality"
                value={report.traffic_quality === null ? "—" : `${Math.round(report.traffic_quality)}%`}
                sub={report.coverage === null ? "coverage n/a" : `${Math.round(report.coverage)}% coverage`}
                title={
                  "Share of analyzed search-term spend spent on non-waste (high-intent) searches. " +
                  "Coverage = how much of total keyword spend Google reports at the term level — the rest is hidden low-volume terms."
                }
              />
              {!report.has_criteria && (
                <div className="ki-hint">
                  No saved criteria — using auto-detected defaults.
                  {" "}
                  <button className="link" onClick={() => setEditing(true)}>
                    Add criteria
                  </button>{" "}
                  to sharpen results.
                </div>
              )}
            </div>

            {report.warnings.length > 0 && (
              <div className="banner banner-amber" data-testid="banner-negatives-warnings">
                {report.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            {report.suggestions.length === 0 ? (
              <div className="panel">
                No wasteful search terms to flag in the last {report.lookback_days} days. 🎉
              </div>
            ) : (
              <div className="ki-table-card">
                <div className="ki-table-head">
                  <span className="muted">
                    Paste-ready — broad has no symbols, "phrase" in quotes, [exact] in brackets.
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
                      onClick={() => setCsvOpen(true)}
                      disabled={selected.size === 0}
                      data-testid="button-download-csv"
                    >
                      Download CSV{selected.size ? ` (${selected.size})` : ""}
                    </button>
                  </div>
                </div>
                <div className="ki-table-scroll">
                <table className="ki-table ki-table-neg">
                  <thead>
                    <tr>
                      <th className="ki-check">
                        <input
                          type="checkbox"
                          aria-label="Select all negatives"
                          checked={selected.size === report.suggestions.length}
                          ref={(el) => {
                            if (el)
                              el.indeterminate =
                                selected.size > 0 && selected.size < report.suggestions.length;
                          }}
                          onChange={toggleAll}
                        />
                      </th>
                      <SortHeader label="Suggested negative" k="negative" sort={sort} onSort={clickSort} />
                      <SortHeader label="Match" k="match" sort={sort} onSort={clickSort} />
                      <SortHeader label="Category" k="category" sort={sort} onSort={clickSort} />
                      <SortHeader label="Search term" k="term" sort={sort} onSort={clickSort} />
                      <SortHeader label="Campaign" k="campaign" sort={sort} onSort={clickSort} />
                      <SortHeader label="Ad group" k="adgroup" sort={sort} onSort={clickSort} />
                      <SortHeader label="Cost" k="cost" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Clicks" k="clicks" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Conv." k="conv" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Conf." k="conf" sort={sort} onSort={clickSort} num />
                      <SortHeader label="Why" k="why" sort={sort} onSort={clickSort} />
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
                        selected={selected.has(i)}
                        onToggle={toggleSelect}
                      />
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
  selected,
  onToggle,
}: {
  s: NegativeSuggestion;
  cur: string;
  copied: string | null;
  onCopy: (t: string, k: string) => void;
  idx: number;
  selected: boolean;
  onToggle: (idx: number) => void;
}) {
  const key = `n${idx}`;
  // Guarded (?? []) so a stale pre-feature payload during a rolling deploy can't crash the page.
  const blocks = s.blocks_converting ?? [];
  return (
    <tr className={selected ? "ki-row-sel" : ""}>
      <td className="ki-check">
        <input
          type="checkbox"
          aria-label={`Select ${s.negative}`}
          checked={selected}
          onChange={() => onToggle(idx)}
        />
      </td>
      <td>
        <button
          className="ki-neg"
          title="Click to copy"
          onClick={() => onCopy(s.negative, key)}
        >
          <code>{s.negative}</code>
          <span className="ki-copy">{copied === key ? "✓" : "⧉"}</span>
        </button>
        {s.covered_terms > 1 && (
          <span className="ki-covers">covers {s.covered_terms} terms</span>
        )}
      </td>
      <td>
        <span className={`ki-match m-${s.match_type}`}>{s.match_type}</span>
      </td>
      <td>
        <span className="ki-cat">{s.category.replace(/_/g, " ")}</span>
      </td>
      <td className="ki-term">{s.search_term}</td>
      <td className="ki-src" title={s.campaign}>{s.campaign}</td>
      <td className="ki-src" title={s.ad_group}>{s.ad_group}</td>
      <td className="num">{money(s.cost, cur)}</td>
      <td className="num">{s.clicks}</td>
      <td className="num">{round1(s.conversions)}</td>
      <td className="num">{Math.round(s.confidence * 100)}%</td>
      <td className="ki-why">
        {s.reason}
        {s.system_note && <div className="ki-note">{s.system_note}</div>}
        {blocks.length > 0 && (
          <div className="ki-conflict-note">
            ⚠ Would also block converting term{blocks.length > 1 ? "s" : ""}:{" "}
            {blocks.map((b, j) => (
              <span key={j}>
                {j > 0 && ", "}
                “{b.search_term}” ({round1(b.conversions)} conv @ {money(b.cpa, cur)})
              </span>
            ))}
            {(s.blocks_converting_more ?? 0) > 0 && ` +${s.blocks_converting_more} more`}
            {" — double-check before adding. If it's really in-area/relevant, update the criteria instead."}
          </div>
        )}
      </td>
    </tr>
  );
}

function NegativeCsvDialog({
  count,
  campaignCount,
  onPick,
  onClose,
}: {
  count: number;
  campaignCount: number;
  onPick: (scope: "own" | "all") => void;
  onClose: () => void;
}) {
  return (
    <div className="ki-modal-backdrop" onMouseDown={onClose}>
      <div className="ki-modal ki-csv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ki-modal-head">
          <h3>
            Download {count} negative{count === 1 ? "" : "s"}
          </h3>
          <button className="link" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="ki-modal-intro">
          A Google Ads Editor CSV, applied at <strong>campaign level</strong>. Which campaigns should
          these negatives apply to?
        </p>
        <div className="ki-csv-choices">
          <button className="ki-csv-choice" onClick={() => onPick("own")} data-testid="button-csv-own">
            <span className="ki-csv-choice-title">Each negative's own campaign</span>
            <span className="ki-csv-choice-sub">
              Every negative applied only to the campaign it was found in.
            </span>
          </button>
          <button
            className="ki-csv-choice"
            onClick={() => onPick("all")}
            disabled={campaignCount === 0}
            data-testid="button-csv-all"
          >
            <span className="ki-csv-choice-title">
              All campaigns in this analysis ({campaignCount})
            </span>
            <span className="ki-csv-choice-sub">
              Every negative applied to all {campaignCount} campaign{campaignCount === 1 ? "" : "s"}{" "}
              with wasteful terms in this report.
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string | number;
  sub?: string;
  title?: string;
}) {
  return (
    <div className="ki-stat" title={title}>
      <div className="ki-stat-val">{value}</div>
      <div className="ki-stat-label">{label}</div>
      {sub && <div className="ki-stat-sub">{sub}</div>}
    </div>
  );
}
