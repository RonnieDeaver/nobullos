/**
 * Ads OS · LSA Hygiene report (/ads-os/lsa/a/{cid}/hygiene) — port of the
 * bundle's frontend/src/components/LsaReport.tsx. LSA hygiene reuses the GAds
 * report UI (the engine emits the same AuditReport shape); a not-enrolled
 * account (no LSA label / no Local Services campaigns) renders the "N/A"
 * panel instead of a gauge.
 */

import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { AuditReport, ScoreHistoryEntry } from "./lib/types";
import { ScoreTrend } from "./components/ScoreTrend";
import { Gauge } from "./components/Gauge";
import { GateBanner } from "./components/GateBanner";
import { CategorySection } from "./components/CategorySection";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { NextSteps } from "./components/NextSteps";
import { formatId } from "./lib/format";
import { AdsOsShell } from "./components/AdsOsShell";
import { Breadcrumbs } from "./components/Breadcrumbs";

export default function LsaHygieneToolPage() {
  const [, params] = useRoute("/ads-os/lsa/a/:cid/hygiene");
  const cid = params?.cid ?? "";

  const isCeo = useIsCeo(); // Gates forced operational controls only.
  const [report, setReport] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [history, setHistory] = useState<ScoreHistoryEntry[]>([]);
  const [nav, setNav] = useState<{ id: string; n: number }>({ id: "", n: 0 });

  function load(force = false) {
    setLoading(true);
    setError(null);
    api
      .lsaHygiene(cid, { force })
      .then((r) => {
        setReport(r);
        setOpen(new Set());
        // Trend is best-effort: the run above just persisted its snapshot.
        api.lsaHygieneHistory(cid).then((h) => setHistory(h.history)).catch(() => {});
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  // Run the audit immediately when the report opens or the account changes.
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

  function focusCheck(checkId: string) {
    const cat = checkId.split("-")[0];
    setOpen((prev) => new Set(prev).add(cat));
    setNav((prev) => ({ id: checkId, n: prev.n + 1 }));
  }

  const name = accountName ?? report?.account_name ?? formatId(cid);
  const capped = !!report && report.final_score < report.raw_score;

  // Not enrolled (no LSA label / no Local Services campaigns) -> band "N/A".
  if (!loading && !error && report && report.band === "N/A") {
    const note = report.next_steps.long_term[0]?.detail ?? "This account isn't enrolled in LSA.";
    return (
      <AdsOsShell>
        <div className="report" data-testid="page-ads-os-lsa-hygiene">
          <Breadcrumbs
            view="lsa-hygiene"
            account={{
              customer_id: cid,
              descriptive_name: report.account_name,
              city: city ?? undefined,
            }}
          />
          <div className="report-top">
            <div className="report-title">
              <h2>
                {report.account_name}
                {city && <span className="dash-city">{city}</span>}
              </h2>
              <span className="muted">{formatId(report.customer_id)} · LSA · Hygiene Audit</span>
            </div>
          </div>
          <div className="panel ki-notenrolled" data-testid="text-lsa-not-enrolled">
            <strong>Not enrolled in LSA Hygiene</strong>
            <div className="muted" style={{ marginTop: 8 }}>{note}</div>
          </div>
        </div>
      </AdsOsShell>
    );
  }

  return (
    <AdsOsShell>
      <div className="report" data-testid="page-ads-os-lsa-hygiene">
        <Breadcrumbs
          view="lsa-hygiene"
          account={{ customer_id: cid, descriptive_name: name, city: city ?? undefined }}
        />
        <div className="report-top">
          <div className="report-title">
            <h2>
              {name}
              {city && <span className="dash-city">{city}</span>}
            </h2>
            <span className="muted">
              LSA Hygiene · {formatId(cid)}
              {report ? ` · last ${report.lookback_days} days · ${report.from_cache ? "cached" : "fresh"}` : ""}
            </span>
          </div>
          <div className="report-actions">
            <a
              className="btn-secondary"
              href={`/api/ads-os/lsa/hygiene/${cid}/report.html`}
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
            Running LSA audit for <strong>{city ? `${name} — ${city}` : name}</strong>…
            <div className="muted">Pulling verification, leads, answer rate, budget & spend</div>
          </div>
        )}

        {!loading && error && (
          <div className="panel error" data-testid="text-audit-error">
            Audit failed: {error}
          </div>
        )}

        {!loading && !error && report && report.band === "Inactive" && (
          <div className="panel" data-testid="text-audit-inactive">
            <h3>Inactive account</h3>
            <div className="muted">
              {report.scope_note ??
                "No active Local Services campaigns in scope — all campaigns are paused or removed."}
            </div>
          </div>
        )}

        {!loading && !error && report && report.band !== "Inactive" && (
          <>
            <div className="report-hero">
              <Gauge score={report.final_score} band={report.band} rawScore={report.raw_score} capped={capped} />
              <ScoreTrend history={history} />
              <GateBanner gates={report.gates_triggered} finalScore={report.final_score} rawScore={report.raw_score} />
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
