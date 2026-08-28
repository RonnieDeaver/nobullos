/**
 * Task #5332 — read-only "Account Alerts" panel for the Hygiene Audit report
 * page. Hygiene Audit checks campaign *configuration* quality; Account
 * Alerts is the separate real-time feed for policy/performance red flags
 * (POL checks were removed from the hygiene catalog per team review — see
 * checksConfig.ts). Without this panel, an operator could see a 99 "Excellent"
 * score right next to a dashboard row showing active critical alerts with no
 * way to know from the report itself.
 *
 * Sourced from the audit endpoint's `alerts`/`alerts_at` fields, which are
 * the same already-persisted store data the combined dashboard's ⚠ badge
 * reads (server/routes/adsOs.ts) — no new computation here. Reuses the shared
 * AlertList presentation (severity/title/detail) and the dashboard's own
 * staleness threshold (AlertBadge.tsx) so a frozen alerts snapshot is flagged
 * the same way it is on the dashboard.
 */

import type { Alert } from "../lib/types";
import { alertsStaleDays, AlertList } from "./AlertBadge";

interface Props {
  alerts?: Alert[] | null;
  alertsAt?: string | null;
}

export function AccountAlertsPanel({ alerts, alertsAt }: Props) {
  const list = alerts ?? [];
  const staleDays = alertsStaleDays(alertsAt);
  // Matches the dashboard badge's own visibility rule: a fresh, empty alert
  // set renders nothing (no empty-state clutter); a frozen "all clear" still
  // surfaces the staleness so it isn't mistaken for a checked-and-clean state.
  if (list.length === 0 && staleDays == null) return null;

  return (
    <div className="panel account-alerts-panel" data-testid="panel-account-alerts">
      <div className="account-alerts-head">
        <h3>Account Alerts</h3>
        <span className="muted">
          Real-time policy &amp; performance flags, tracked separately from the Hygiene
          score below — a high score next to visible alerts means different checks, not a
          contradiction.
        </span>
      </div>
      {list.length > 0 ? (
        <AlertList alerts={list} />
      ) : (
        <div className="muted account-alerts-empty" data-testid="text-account-alerts-empty">
          No active alerts recorded as of the last check.
        </div>
      )}
      {staleDays != null && (
        <div className="account-alerts-stale" data-testid="text-account-alerts-stale">
          ⧗ Alerts last checked {staleDays}d ago — may be out of date.
        </div>
      )}
    </div>
  );
}
