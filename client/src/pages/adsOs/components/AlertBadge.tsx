import React, { useState } from "react";
import type { Alert, ClickUpTaskRef } from "../lib/types";

// Worst-severity rank for coloring the badge / sorting.
function rank(s: string): number {
  return s === "critical" ? 3 : s === "high" ? 2 : s === "medium" ? 1 : 0;
}

// Worst-severity-first ordering, shared by the badge tooltip and the expanded list
// so the two always agree.
function bySeverity(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => rank(b.severity) - rank(a.severity));
}

// Alerts are recomputed by the morning cron; a run that fails for an account leaves
// its stored alerts (and their timestamp) untouched, so the badge would silently show
// a frozen state. Treat alerts not refreshed within ~2 daily cycles as stale.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

// Age in whole days when the alerts data is stale (older than the threshold), else null.
// A missing timestamp returns null (treated as "not yet checked", not stale) to avoid
// noise on accounts the cron hasn't reached — the target is the frozen-after-success case.
export function alertsStaleDays(alertsAt: string | null | undefined): number | null {
  if (!alertsAt) return null;
  const t = Date.parse(alertsAt);
  if (Number.isNaN(t)) return null;
  const ageMs = Date.now() - t;
  return ageMs >= STALE_AFTER_MS ? Math.floor(ageMs / 86_400_000) : null;
}

// Compact ⚠ N badge shown on a dashboard row, colored by the worst alert and listing
// the alert titles on hover. When the underlying alerts data is stale (the daily job
// hasn't refreshed this account in a while), the badge is dimmed and annotated — and a
// stale "all clear" (no alerts, but frozen) surfaces a small marker instead of nothing,
// so a frozen no-alerts state isn't mistaken for a fresh all-clear.
export function AlertBadge({ alerts, alertsAt }: { alerts: Alert[]; alertsAt?: string | null }) {
  const staleDays = alertsStaleDays(alertsAt);
  if (!alerts || alerts.length === 0) {
    if (staleDays == null) return null;
    return (
      <span
        className="dash-alertbadge stale"
        title={`Alerts last checked ${staleDays}d ago — may be out of date`}
      >
        ⧗ {staleDays}d
      </span>
    );
  }
  const worst = alerts.reduce((m, a) => Math.max(m, rank(a.severity)), 0);
  const cls = worst >= 3 ? "crit" : worst >= 2 ? "high" : "med";
  const titles = bySeverity(alerts).map((a) => `• ${a.title}`).join("\n");
  const title = staleDays == null ? titles : `${titles}\n(last checked ${staleDays}d ago — may be out of date)`;
  return (
    <span className={`dash-alertbadge ${cls}${staleDays == null ? "" : " stale"}`} title={title}>
      ⚠ {alerts.length}
      {staleDays == null ? "" : " ⧗"}
    </span>
  );
}

// ClickUp wiring passed down from the dashboard: whether the integration is on,
// the (optimistic) task pointer for an alert, and the create handler.
export interface ClickUpBinding {
  enabled: boolean;
  taskFor: (a: Alert) => ClickUpTaskRef | null | undefined;
  onCreate: (a: Alert) => Promise<void>;
}

// Full alert list shown inside an expanded row, above the tool links.
export function AlertList({ alerts, clickup }: { alerts: Alert[]; clickup?: ClickUpBinding }) {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<Record<string, string>>({});

  async function create(a: Alert) {
    if (!clickup) return;
    setBusy((s) => new Set(s).add(a.code));
    setErr((e) => ({ ...e, [a.code]: "" }));
    try {
      await clickup.onCreate(a);
    } catch (e) {
      setErr((prev) => ({ ...prev, [a.code]: (e as Error).message || "Couldn't create task" }));
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(a.code);
        return n;
      });
    }
  }

  if (!alerts || alerts.length === 0) return null;
  const sorted = bySeverity(alerts);
  return (
    <div className="dash-alerts" onClick={(e) => e.stopPropagation()}>
      {sorted.map((a, i) => {
        const ref = clickup?.taskFor(a) ?? a.clickup_task;
        return (
          <div key={`${a.code}-${i}`} className={`dash-alert-item sev-${a.severity}`}>
            <span className="dash-alert-dot" />
            <div className="dash-alert-body">
              <span className="dash-alert-title">{a.title}</span>
              {a.detail && <span className="dash-alert-detail">{a.detail}</span>}
              {err[a.code] && <span className="dash-alert-cu-err" role="alert">{err[a.code]}</span>}
            </div>
            <div className="dash-alert-actions">
              {a.deep_link && (
                <a
                  className="dash-alert-link"
                  href={a.deep_link}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ↗
                </a>
              )}
              {clickup?.enabled &&
                (ref ? (
                  <a
                    className="dash-alert-cu view"
                    href={ref.url ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View ClickUp Task ↗
                  </a>
                ) : (
                  <button
                    type="button"
                    className="dash-alert-cu"
                    disabled={busy.has(a.code)}
                    onClick={() => create(a)}
                  >
                    {busy.has(a.code) ? "Creating…" : "Create ClickUp Task"}
                  </button>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
