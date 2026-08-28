/**
 * Ads OS · GAds Hygiene Audit (/ads-os/a/{cid}/audit) — port of the bundle's
 * frontend/src/components/Report.tsx.
 *
 * NoBull OS adaptation: the CID comes from the wouter route and the header
 * name resolves from the monitored-accounts list (best-effort — the report
 * itself carries account_name, so an unresolved list never blocks the tool).
 * Auto-runs on open (1h server cache); Re-run forces a fresh audit. Export
 * HTML opens the standalone server-rendered report.
 */

import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { AuditReport, ScoreHistoryEntry } from "./lib/types";
import { ScoreTrend } from "./components/ScoreTrend";
import { Gauge } from "./components/Gauge";
import { GateBanner } from "./components/GateBanner";
import { AccountAlertsPanel } from "./components/AccountAlertsPanel";
import { CategorySection } from "./components/CategorySection";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { NextSteps } from "./components/NextSteps";
import { formatId } from "./lib/format";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";

export default function HygieneAuditToolPage() {
  const [, params] = useRoute("/ads-os/a/:cid/audit");
  // Alias route (/ads-os/audit/:cid) — same page, shorter shareable path.
  const [, aliasParams] = useRoute("/ads-os/audit/:cid");
  const cid = params?.cid ?? aliasParams?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [history, setHistory] = useState<ScoreHistoryEntry[]>([]);
  // nav.n increments on every Next-steps chip click so the same chip re-triggers.
  const [nav, setNav] = useState<{ id: string; n: number }>({ id: "", n: 0 });

  function load(force = false) {
    setLoading(true);
    setError(null);
    api
      .audit(cid, { force })
      .then((r) => {
        setReport(r);
        setOpen(new Set()); // all categories collapsed on load
        // Trend is best-effort: the run above just persisted its snapshot.
        api.auditHistory(cid).then((h) => setHistory(h.history)).catch(() => {});
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  // Run the audit immediately when the report opens or the account changes.
  useEffect(() => {
    setReport(null);
    load();
    // Best-effort name resolution for the header while the audit computes.
    api
      .monitoredAccounts()
      .then((accts) => {
        const a = accts.find((x) => x.customer_id === cid);
        if (a) setAccountName(a.descriptive_name);
      })
      .catch(() => {}); // header falls back to the report's own account_name
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid]);

  function toggle(code: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }

  const allOpen = !!report && open.size === report.categories.length;
  function toggleAll() {
    if (!report) return;
    setOpen(allOpen ? new Set() : new Set(report.categories.map((c) => c.code)));
  }

  // Jump from a Next-steps chip (e.g. "BID-01") to that check below: open its
  // category and bump nav — the matching CheckCard opens, scrolls into view, and
  // flashes. Incrementing n means clicking the same chip again re-triggers it.
  function focusCheck(checkId: string) {
    const cat = checkId.split("-")[0];
    setOpen((prev) => new Set(prev).add(cat));
    setNav((prev) => ({ id: checkId, n: prev.n + 1 }));
  }

  const name = accountName ?? report?.account_name ?? formatId(cid);
  const capped = !!report && report.final_score < report.raw_score;

  return (
    <AdsOsShell>
      <div className="report" data-testid="page-ads-os-audit">
        <Breadcrumbs view="audit" account={{ customer_id: cid, descriptive_name: name }} />
        <div className="report-top">
          <div className="report-title">
            <h2>{name}</h2>
            <span className="muted">
              Hygiene Audit · {formatId(cid)}
              {report ? ` · last ${report.lookback_days} days · ${report.from_cache ? "cached" : "fresh"}` : ""}
            </span>
          </div>
          <div className="report-actions">
            <a
              className="btn-secondary"
              href={`/api/ads-os/audit/${cid}/report.html`}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="link-export-html"
            >
              Export HTML
            </a>
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
              data-testid="button-rerun-audit"
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
            onSaved={() => setEditing(false)}
          />
        )}

        {loading && (
          <div className="panel loading">
            <div className="spinner" />
            Running audit for <strong>{name}</strong>…
            <div className="muted">Pulling campaigns, ads, keywords, assets & search terms</div>
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-audit-error">
            Audit failed: {error}
          </div>
        )}

        {!loading && !error && report && (
          <AccountAlertsPanel alerts={report.alerts} alertsAt={report.alerts_at} />
        )}

        {!loading && !error && report && report.band === "Inactive" && (
          <div className="panel" data-testid="text-audit-inactive">
            <h3>Inactive account</h3>
            <div className="muted">
              {report.scope_note ??
                "No active labeled campaigns in scope — all labeled campaigns are paused, ended, or dormant."}
            </div>
          </div>
        )}

        {!loading && !error && report && report.band !== "Inactive" && (
          <>
            <div className={`report-hero${report.gates_triggered.length > 0 ? " has-gates" : ""}`}>
              <Gauge
                score={report.final_score}
                band={report.band}
                rawScore={report.raw_score}
                capped={capped}
              />
              <ScoreTrend history={history} />
              <GateBanner
                gates={report.gates_triggered}
                finalScore={report.final_score}
                rawScore={report.raw_score}
              />
            </div>

            <NextSteps data={report.next_steps} onNavigate={focusCheck} />

            <div className="breakdown">
              <div className="breakdown-head">
                <h3>Category breakdown <span className="muted">(worst first)</span></h3>
                <button className="link" onClick={toggleAll}>
                  {allOpen ? "collapse all" : "expand all"}
                </button>
              </div>
              {report.categories.map((c) => (
                <CategorySection
                  key={c.code}
                  category={c}
                  expanded={open.has(c.code)}
                  onToggle={() => toggle(c.code)}
                  nav={nav}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </AdsOsShell>
  );
}
