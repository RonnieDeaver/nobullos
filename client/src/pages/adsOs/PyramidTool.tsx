/**
 * Ads OS · Pyramid Breakdown (/ads-os/a/{cid}/pyramid) — port of the bundle's
 * frontend/src/components/PyramidBreakdown.tsx.
 *
 * NoBull OS adaptation (same pattern as the Analyzer pages): the CID comes from
 * the wouter route and the header name resolves best-effort from the
 * monitored-accounts list (the report itself carries account_name, so an
 * unresolved list never blocks the tool). Auto-runs on open (1h server cache);
 * Re-run forces a fresh review. Display-only — the footnote hands off to the
 * Search Term Analyzer for paste-ready negatives.
 */

import { useEffect, useMemo, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Link, useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type {
  PyramidAction,
  PyramidAdGroup,
  PyramidCampaign,
  PyramidKeyword,
  PyramidReport,
  PyramidSearchTerm,
} from "./lib/types";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { money, round1, formatId } from "./lib/format";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { EmptyState } from "@/components/kit/EmptyState";

// Display copy + chip class per action. Order fixed for the summary chips.
const ACTIONS: PyramidAction[] = ["scale", "keep", "watch", "throttle", "pause"];
const ACTION_LABEL: Record<string, string> = {
  scale: "Scale",
  keep: "Keep",
  watch: "Watch",
  throttle: "Throttle",
  pause: "Pause",
  none: "Already paused",
};

// Human copy for the deterministic rule flags (badges).
const FLAG_LABEL: Record<string, string> = {
  KW_PAUSE_ZERO_CONV: "0 conv · >2× CPL spent",
  KW_PAUSE_ONE_CONV: "≤1 conv · >3× CPL spent",
  KW_PAUSE_HIGH_CPL: "CPL >2× baseline",
  KW_WATCH_SPEND: "approaching pause line",
  KW_LOW_QS: "low quality score",
  KW_INSUFFICIENT: "not enough data",
  AG_PAUSE_ZERO_CONV: "0 conv · >2× CPL spent",
  AG_HIGH_CPL: "CPL >2× baseline",
  AG_WATCH_SPEND: "approaching pause line",
  AG_IRRELEVANT_TRAFFIC: "dirty traffic",
  AG_INSUFFICIENT: "not enough data",
  CAMP_PAUSE_ZERO_CONV: "0 conv · >3× CPL spent",
  CAMP_THROTTLE_ZERO_CONV: "0 conv · high spend",
  CAMP_THROTTLE_HIGH_CPL: "CPL >2× account",
  CAMP_SCALE: "scale headroom",
  CAMP_SCALE_TCPA: "beating target CPA",
  CAMP_RANK_LIMITED: "rank-limited",
  CAMP_INSUFFICIENT: "not enough data",
};

export default function PyramidToolPage() {
  const [, params] = useRoute("/ads-os/a/:cid/pyramid");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<PyramidReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [termFilter, setTermFilter] = useState<string>("all");
  const [accountName, setAccountName] = useState<string | null>(null);

  function load(force = false) {
    setLoading(true);
    setError(null);
    api
      .pyramid(cid, { force })
      .then(setReport)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setReport(null);
    setTermFilter("all");
    load();
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

  const name = accountName ?? report?.account_name ?? formatId(cid);
  const cur = report?.currency_code ?? "";

  // Flat search-term list for the bottom tier (the report nests terms per ad
  // group with display caps; flatten + de-dup for the account-wide table).
  const flatTerms = useMemo(() => {
    if (!report) return [];
    const out: Array<{ t: PyramidSearchTerm; adGroup: string; campaign: string }> = [];
    const seen = new Set<string>();
    for (const c of report.campaigns) {
      for (const g of c.ad_groups) {
        for (const t of g.search_terms) {
          const key = `${g.id}:${t.search_term}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ t, adGroup: g.name, campaign: c.name });
        }
      }
    }
    return out.sort((a, b) => b.t.cost - a.t.cost);
  }, [report]);

  const shownTerms = useMemo(() => {
    if (termFilter === "all") return flatTerms;
    if (termFilter === "unscored") return flatTerms.filter(({ t }) => t.relevancy === null);
    return flatTerms.filter(({ t }) => t.relevancy_label === termFilter);
  }, [flatTerms, termFilter]);

  const tierCounts = useMemo(() => {
    if (!report) return null;
    let adGroups = 0, agFlagged = 0, kws = 0;
    for (const c of report.campaigns) {
      for (const g of c.ad_groups) {
        adGroups++;
        if (g.action === "pause" || g.action === "watch") agFlagged++;
        kws += g.keywords_total;
      }
    }
    const kwFlagged = report.rollup.flagged_keywords;
    const campFlagged = report.campaigns.filter((c) =>
      ["pause", "throttle", "watch", "scale"].includes(c.action)
    ).length;
    return { campaigns: report.campaigns.length, campFlagged, adGroups, agFlagged, kws, kwFlagged, terms: flatTerms.length };
  }, [report, flatTerms]);

  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
  }

  return (
    <AdsOsShell>
      <div className="report pyr" data-testid="page-ads-os-pyramid">
        <Breadcrumbs view="pyramid" account={{ customer_id: cid, descriptive_name: name }} />
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">
              Pyramid Breakdown · {formatId(cid)}
              {report
                ? ` · ${report.window_start && report.window_end
                    ? `${report.window_start} → ${report.window_end}`
                    : `last ${report.lookback_days} days`} · ${report.from_cache ? "cached" : "fresh"}`
                : ""}
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
              data-testid="button-rerun-pyramid"
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
              load(isCeo);
            }}
          />
        )}

        {loading && (
          <div className="panel loading">
            <div className="spinner" />
            Reviewing the account pyramid for <strong>{name}</strong>…
            <div className="muted">
              Pulling 30 days of campaigns, ad groups, keywords & search terms, scoring term
              relevancy, then asking the strategist model — a fresh run can take a minute or two.
            </div>
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-pyramid-error">
            {error}
          </div>
        )}

        {!loading && !error && report && !report.eligible && (
          <div className="panel ki-notenrolled">
            <strong>Not enrolled in Pyramid Breakdown</strong>
            <div className="muted" style={{ marginTop: 8 }}>{report.scope_note}</div>
          </div>
        )}

        {!loading && !error && report && report.eligible && tierCounts && (
          <>
            {report.warnings.length > 0 && (
              <div className="banner banner-amber">
                {report.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}

            {/* ═══ Executive summary ═══ */}
            <div className="pyr-summary-card">
              <div className="pyr-summary-main">
                <div className="pyr-summary-head">
                  <h3>Executive summary</h3>
                  <span className={`pyr-ai-status s-${report.ai_status}`}>
                    {report.ai_status === "full"
                      ? `AI review · ${report.ai_model_used}`
                      : report.ai_status === "partial"
                      ? `partial AI review${report.ai_model_used ? ` · ${report.ai_model_used}` : ""}`
                      : "rules-only review"}
                  </span>
                </div>
                <p className="pyr-exec">{report.executive_summary}</p>
                {report.baseline_note && <p className="pyr-baseline-note">{report.baseline_note}</p>}
                {report.next_steps.length > 0 && (
                  <ol className="pyr-steps">
                    {report.next_steps.map((s) => (
                      <li key={s.priority}>{s.step}</li>
                    ))}
                  </ol>
                )}
              </div>
              <div className="pyr-summary-side">
                <div className="pyr-stats">
                  <Stat label="Spend (30d)" value={money(report.account_cost, cur)} />
                  <Stat label="Leads" value={round1(report.account_conversions)} />
                  <Stat
                    label="Account CPL"
                    value={report.account_cpl === null ? "—" : money(report.account_cpl, cur)}
                  />
                  <Stat
                    label="Killer keyword spend"
                    value={money(report.rollup.flagged_keyword_cost, cur)}
                    sub={`${report.rollup.flagged_keywords} keyword(s)`}
                  />
                  <Stat
                    label="Irrelevant term spend"
                    value={money(report.rollup.irrelevant_term_cost, cur)}
                    sub={
                      report.rollup.relevancy_avg === null
                        ? "not scored"
                        : `avg relevancy ${Math.round(report.rollup.relevancy_avg)}/100`
                    }
                  />
                </div>
                <div className="pyr-action-chips">
                  {ACTIONS.map((a) =>
                    report.rollup.action_counts[a] ? (
                      <span key={a} className={`pyr-chip a-${a}`}>
                        {ACTION_LABEL[a]} {report.rollup.action_counts[a]}
                      </span>
                    ) : null
                  )}
                </div>
                {!report.has_criteria && (
                  <div className="ki-hint">
                    No saved criteria — using auto-detected defaults.
                    {" "}
                    <button className="link" onClick={() => setEditing(true)}>
                      Add criteria
                    </button>{" "}
                    to sharpen the relevancy scoring.
                  </div>
                )}
              </div>
            </div>

            {/* ═══ Pyramid tier nav ═══ */}
            <div className="pyr-tiers" role="navigation" aria-label="Pyramid tiers">
              <button className="pyr-tier t1" onClick={() => jump("pyr-campaigns")}>
                <span className="pyr-tier-name">Campaigns</span>
                <span className="pyr-tier-count">
                  {tierCounts.campaigns}
                  {tierCounts.campFlagged > 0 && <em> · {tierCounts.campFlagged} to action</em>}
                </span>
              </button>
              <button className="pyr-tier t2" onClick={() => jump("pyr-campaigns")}>
                <span className="pyr-tier-name">Ad groups</span>
                <span className="pyr-tier-count">
                  {tierCounts.adGroups}
                  {tierCounts.agFlagged > 0 && <em> · {tierCounts.agFlagged} flagged</em>}
                </span>
              </button>
              <button className="pyr-tier t3" onClick={() => jump("pyr-keywords")}>
                <span className="pyr-tier-name">Keywords</span>
                <span className="pyr-tier-count">
                  {tierCounts.kws}
                  {tierCounts.kwFlagged > 0 && <em> · {tierCounts.kwFlagged} to pause</em>}
                </span>
              </button>
              <button className="pyr-tier t4" onClick={() => jump("pyr-terms")}>
                <span className="pyr-tier-name">Search terms</span>
                <span className="pyr-tier-count">
                  {tierCounts.terms}
                  {report.rollup.scored_terms > 0 && <em> · {report.rollup.scored_terms} scored</em>}
                </span>
              </button>
            </div>

            {/* ═══ Campaigns ═══ */}
            <section id="pyr-campaigns" className="pyr-section">
              <h3 className="pyr-section-h">Campaigns</h3>
              {report.campaigns.length === 0 && (
                <div className="panel">
                  <EmptyState
                    title="No campaign activity in this window"
                    description="No monitored campaign recorded spend or conversions over the selected date range."
                    hint="Widen the date range, or check that campaigns are enabled and carry the monitoring label."
                    testId="empty-pyr-campaigns"
                  />
                </div>
              )}
              {report.campaigns.map((c) => (
                <CampaignCard key={c.id} c={c} cur={cur} />
              ))}
            </section>

            {/* ═══ Killer keywords ═══ */}
            <section id="pyr-keywords" className="pyr-section">
              <h3 className="pyr-section-h">
                Killer keywords
                <span className="muted">
                  {" "}
                  — pause-flagged by the checklist rules
                  {report.rollup.flagged_keywords > 0 &&
                    ` · ${money(report.rollup.flagged_keyword_cost, cur)} in the window`}
                </span>
              </h3>
              {report.rollup.killer_keywords.length === 0 ? (
                <div className="panel">
                  <EmptyState
                    title="No keywords need pausing 🎉"
                    description="No keyword tripped the pause-flag checklist rules over this window — nothing to act on here."
                    hint="Re-check after the next data pull, or widen the date range to see longer-run offenders."
                    testId="empty-pyr-keywords"
                  />
                </div>
              ) : (
                <div className="ki-table-card">
                  <div className="ki-table-scroll">
                    <table className="ki-table pyr-table">
                      <thead>
                        <tr>
                          <th>Keyword</th>
                          <th>Match</th>
                          <th>Campaign › Ad group</th>
                          <th className="num">Cost</th>
                          <th className="num">Clicks</th>
                          <th className="num">Conv.</th>
                          <th className="num">CPL</th>
                          <th className="num">QS</th>
                          <th>Rule</th>
                          <th>Why</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.rollup.killer_keywords.map((k, i) => (
                          <KeywordRow key={i} k={k} cur={cur} showPath />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ═══ Search terms ═══ */}
            <section id="pyr-terms" className="pyr-section">
              <div className="pyr-terms-head">
                <h3 className="pyr-section-h">
                  Search-term relevancy
                  {report.rollup.scored_terms > 0 && (
                    <span className="muted">
                      {" "}
                      — {report.rollup.scored_terms} terms scored ·{" "}
                      {money(report.rollup.irrelevant_term_cost, cur)} on irrelevant searches
                    </span>
                  )}
                </h3>
                <select
                  className="ki-range"
                  value={termFilter}
                  onChange={(e) => setTermFilter(e.target.value)}
                  aria-label="Filter search terms"
                  data-testid="select-term-filter"
                >
                  <option value="all">All terms ({flatTerms.length})</option>
                  <option value="irrelevant">Irrelevant</option>
                  <option value="adjacent">Adjacent</option>
                  <option value="relevant">Relevant</option>
                  <option value="high_intent">High intent</option>
                  <option value="unscored">Not scored</option>
                </select>
              </div>
              {shownTerms.length === 0 ? (
                <div className="panel">
                  <EmptyState
                    title="No search terms in this view"
                    description="No search term matches the relevancy filter you've selected for this window."
                    hint="Switch the filter above back to “All terms” to see everything scored."
                    action={
                      termFilter !== "all" ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => setTermFilter("all")}
                          data-testid="button-pyr-show-all-terms"
                        >
                          Show all terms
                        </button>
                      ) : undefined
                    }
                    testId="empty-pyr-terms"
                  />
                </div>
              ) : (
                <div className="ki-table-card">
                  <div className="ki-table-scroll">
                    <table className="ki-table pyr-table">
                      <thead>
                        <tr>
                          <th>Search term</th>
                          <th>Relevancy</th>
                          <th>Why</th>
                          <th>Matched keyword</th>
                          <th>Ad group</th>
                          <th className="num">Cost</th>
                          <th className="num">Clicks</th>
                          <th className="num">Conv.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownTerms.slice(0, 150).map(({ t, adGroup }, i) => (
                          <TermRow key={i} t={t} adGroup={adGroup} cur={cur} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {shownTerms.length > 150 && (
                    <div className="pyr-table-foot muted">
                      Showing the 150 highest-cost of {shownTerms.length} terms.
                    </div>
                  )}
                </div>
              )}
              <div className="muted pyr-footnote">
                To actually block wasteful terms, use the{" "}
                <Link href={`/ads-os/a/${cid}/analyzer/negatives`}>Search Term Analyzer</Link> — it
                builds safe, paste-ready negatives.
              </div>
            </section>
          </>
        )}
      </div>
    </AdsOsShell>
  );
}

// ─────────────────────────── Campaign card ───────────────────────────
function CampaignCard({ c, cur }: { c: PyramidCampaign; cur: string }) {
  const [open, setOpen] = useState(
    c.action === "pause" || c.action === "throttle" || c.action === "scale"
  );
  const flaggedAgs = c.ad_groups.filter((g) => g.action === "pause" || g.action === "watch").length;
  return (
    <div className={`pyr-camp a-edge-${c.action}`}>
      <div className="pyr-camp-head">
        <div className="pyr-camp-title">
          <ActionChip action={c.action} />
          <strong>{c.name}</strong>
          {c.status !== "ENABLED" && <span className="pyr-status">{c.status.toLowerCase()}</span>}
          <span className="pyr-chan muted">
            {c.channel_type !== "SEARCH" ? c.channel_type.replace(/_/g, " ") : ""}
          </span>
        </div>
        {c.confidence !== null && (
          <span className="muted pyr-conf" title="Strategist confidence">
            {Math.round(c.confidence * 100)}% confident
          </span>
        )}
      </div>
      <div className="pyr-metrics">
        <Metric label="Spend" value={money(c.cost, cur)} />
        <Metric label="Leads" value={round1(c.conversions)} />
        <Metric
          label="CPL"
          value={c.cpl === null ? "—" : money(c.cpl, cur)}
          sub={
            c.baseline_cpl !== null
              ? `vs ${money(c.baseline_cpl, cur)} ${c.baseline_source === "account" ? "acct" : ""} baseline`
              : undefined
          }
        />
        {c.search_is !== null && <Metric label="Impr. share" value={`${Math.round(c.search_is)}%`} />}
        {c.lost_is_budget !== null && (
          <Metric label="Lost IS (budget)" value={`${Math.round(c.lost_is_budget)}%`} />
        )}
        {c.lost_is_rank !== null && (
          <Metric label="Lost IS (rank)" value={`${Math.round(c.lost_is_rank)}%`} />
        )}
        {c.daily_budget !== null && <Metric label="Budget" value={`${money(c.daily_budget, cur)}/day`} />}
      </div>
      {c.recommended_budget_change_pct !== null && (
        <div className={`pyr-budget-rec ${c.recommended_budget_change_pct > 0 ? "up" : "down"}`}>
          {c.recommended_budget_change_pct > 0 ? "▲ Raise" : "▼ Cut"} daily budget ~
          {Math.abs(Math.round(c.recommended_budget_change_pct))}%
          {c.daily_budget !== null &&
            ` (${money(c.daily_budget, cur)} → ${money(
              c.daily_budget * (1 + c.recommended_budget_change_pct / 100),
              cur
            )})`}
        </div>
      )}
      {c.rationale && <p className="pyr-rationale">{c.rationale}</p>}
      <FlagBadges flags={c.flags} />
      {c.ad_groups.length > 0 && (
        <button className="pyr-expander" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className={`pyr-chev${open ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
          Ad groups ({c.ad_groups.length}
          {flaggedAgs > 0 ? `, ${flaggedAgs} flagged` : ""})
        </button>
      )}
      {open && c.ad_groups.length > 0 && (
        <div className="pyr-ag-wrap">
          {c.ad_groups.map((g) => (
            <AdGroupRow key={g.id} g={g} cur={cur} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Ad group row (expandable) ───────────────────────────
function AdGroupRow({ g, cur }: { g: PyramidAdGroup; cur: string }) {
  const [open, setOpen] = useState(false);
  const hasDetail = g.keywords.length > 0 || g.search_terms.length > 0;
  return (
    <div className="pyr-ag">
      <button
        className="pyr-ag-row"
        onClick={() => hasDetail && setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!hasDetail}
      >
        <span className="pyr-ag-name">
          {hasDetail && (
            <span className={`pyr-chev${open ? " open" : ""}`} aria-hidden="true">
              ▸
            </span>
          )}
          {g.name}
          {g.status !== "ENABLED" && <span className="pyr-status">{g.status.toLowerCase()}</span>}
        </span>
        <span className="pyr-ag-stats tnum">
          {money(g.cost, cur)} · {round1(g.conversions)} leads ·{" "}
          {g.cpl === null ? "no CPL" : `${money(g.cpl, cur)} CPL`}
          {g.relevancy_avg !== null && ` · relevancy ${Math.round(g.relevancy_avg)}`}
        </span>
        <ActionChip action={g.action} />
      </button>
      {g.rationale && <div className="pyr-ag-rationale muted">{g.rationale}</div>}
      {open && (
        <div className="pyr-ag-detail">
          {g.keywords.length > 0 && (
            <>
              <div className="pyr-ag-detail-h">
                Keywords ({g.keywords_total}
                {g.keywords_total > g.keywords.length ? `, top ${g.keywords.length} shown` : ""})
              </div>
              <div className="ki-table-scroll">
                <table className="ki-table pyr-table pyr-table-sm">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Match</th>
                      <th className="num">Cost</th>
                      <th className="num">Clicks</th>
                      <th className="num">Conv.</th>
                      <th className="num">CPL</th>
                      <th className="num">QS</th>
                      <th>Rule</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.keywords.map((k, i) => (
                      <KeywordRow key={i} k={k} cur={cur} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {g.search_terms.length > 0 && (
            <>
              <div className="pyr-ag-detail-h">
                Search terms ({g.search_terms_total}
                {g.search_terms_total > g.search_terms.length
                  ? `, ${g.search_terms.length} shown`
                  : ""})
              </div>
              <div className="ki-table-scroll">
                <table className="ki-table pyr-table pyr-table-sm">
                  <thead>
                    <tr>
                      <th>Search term</th>
                      <th>Relevancy</th>
                      <th>Why</th>
                      <th className="num">Cost</th>
                      <th className="num">Clicks</th>
                      <th className="num">Conv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.search_terms.map((t, i) => (
                      <TermRow key={i} t={t} cur={cur} compact />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Table rows + chips ───────────────────────────
function KeywordRow({ k, cur, showPath = false }: { k: PyramidKeyword; cur: string; showPath?: boolean }) {
  const rule = k.flags.find((f) => f.startsWith("KW_PAUSE"));
  return (
    <tr>
      <td className="ki-term">
        {k.text}
        {k.status !== "ENABLED" && <span className="pyr-status">{k.status.toLowerCase()}</span>}
      </td>
      <td>
        <span className={`ki-match m-${k.match_type.toLowerCase()}`}>
          {k.match_type.toLowerCase().replace(/_/g, " ")}
        </span>
      </td>
      {showPath && (
        <td className="ki-src" title={`${k.campaign_name} › ${k.ad_group_name}`}>
          {k.campaign_name} › {k.ad_group_name}
        </td>
      )}
      <td className="num">{money(k.cost, cur)}</td>
      <td className="num">{k.clicks}</td>
      <td className="num">{round1(k.conversions)}</td>
      <td className="num">{k.cpl === null ? "—" : money(k.cpl, cur)}</td>
      <td className="num">{k.quality_score || "—"}</td>
      <td>
        {rule ? <span className="pyr-rule">{FLAG_LABEL[rule] ?? rule}</span> : <span className="muted">—</span>}
        {k.ai_agrees === false && (
          <span className="pyr-dissent" title="The AI reviewer disagrees with this pause — see Why.">
            AI dissents
          </span>
        )}
      </td>
      <td className="ki-why">{k.rationale}</td>
    </tr>
  );
}

function TermRow({
  t,
  adGroup,
  cur,
  compact = false,
}: {
  t: PyramidSearchTerm;
  adGroup?: string;
  cur: string;
  compact?: boolean;
}) {
  return (
    <tr>
      <td className="ki-term">
        {t.search_term}
        {t.targeting_status === "ADDED" && <span className="pyr-ts added">added</span>}
        {(t.targeting_status === "EXCLUDED" || t.targeting_status === "ADDED_EXCLUDED") && (
          <span className="pyr-ts excluded">excluded</span>
        )}
      </td>
      <td>
        <RelevancyChip score={t.relevancy} label={t.relevancy_label} />
      </td>
      <td className="ki-why">{t.relevancy_reason}</td>
      {!compact && <td className="ki-src">{t.matched_keywords.join(", ") || "—"}</td>}
      {!compact && <td className="ki-src">{adGroup}</td>}
      <td className="num">{money(t.cost, cur)}</td>
      <td className="num">{t.clicks}</td>
      <td className="num">{round1(t.conversions)}</td>
    </tr>
  );
}

function ActionChip({ action }: { action: PyramidAction }) {
  return <span className={`pyr-chip a-${action}`}>{ACTION_LABEL[action] ?? action}</span>;
}

function RelevancyChip({ score, label }: { score: number | null; label: string }) {
  if (score === null) return <span className="pyr-rel unscored">—</span>;
  const cls =
    label === "high_intent" ? "hi" : label === "relevant" ? "rel" : label === "adjacent" ? "adj" : "irr";
  return (
    <span className={`pyr-rel ${cls}`} title={label.replace(/_/g, " ")}>
      {score}
    </span>
  );
}

function FlagBadges({ flags }: { flags: string[] }) {
  const shown = flags.filter((f) => FLAG_LABEL[f]);
  if (shown.length === 0) return null;
  return (
    <div className="pyr-flags">
      {shown.map((f) => (
        <span key={f} className="pyr-rule">
          {FLAG_LABEL[f]}
        </span>
      ))}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="pyr-metric">
      <div className="pyr-metric-val tnum">{value}</div>
      <div className="pyr-metric-label">{label}</div>
      {sub && <div className="pyr-metric-sub muted">{sub}</div>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="ki-stat">
      <div className="ki-stat-val">{value}</div>
      <div className="ki-stat-label">{label}</div>
      {sub && <div className="ki-stat-sub">{sub}</div>}
    </div>
  );
}
