/**
 * Ads OS module shell: scoped theme root (.ads-os), top bar with the module
 * brand + dashboard tabs, and the ClickUp-degradation warning banner (spec §4
 * "Degradation, not failure" — when the ClickUp directory is unreachable the
 * dashboards keep working from the label fallback and say so, never a blank page).
 *
 * Adapted from the bundle's frontend/src/App.tsx top bar for NoBull OS routing
 * (wouter paths instead of hash routes), including the ⌘K "Jump to…" palette.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { api } from "../lib/api";
import type { ClientRef, MonitoredAccount } from "../lib/types";
import { clientPool, gadsPool, lsaPool } from "../lib/dirPools";
import { CommandPalette } from "./CommandPalette";
import "../adsOs.css";

/** Bundle age above which the topbar offers a manual "Reload directory"
 *  (Task #3609) — matches the server-side 10-min directory TTL. */
const DIR_RELOAD_AFTER_MS = 10 * 60 * 1000;
/** Module tabs. `ceoOnly` tabs are engineering/verification surfaces whose
 *  APIs are already CEO-gated server-side (`requireCeo`); hiding them from the
 *  default nav keeps operators from stumbling into a page of failing checks
 *  (design audit P3-7, Task #4375). Visibility fails closed while the auth
 *  probe is still loading. */
const TABS: { path: string; label: string; ceoOnly?: boolean }[] = [
  { path: "/ads-os", label: "Main Dashboard" },
  { path: "/ads-os/am", label: "AM Dashboard" },
  { path: "/ads-os/gads", label: "Google Ads" },
  { path: "/ads-os/lsa", label: "LSA" },
  { path: "/ads-os/proofs", label: "System Checks", ceoOnly: true },
];

/** "34 minutes ago" / "2 hours ago" for the stale banner; falls back to the
 *  locale time string when the timestamp is unparsable. */
function formatStaleSince(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return `at ${iso}`;
  const mins = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `on ${new Date(t).toLocaleString()}`;
}

export function AdsOsShell({
  children,
  clickupLive,
  clickupReason,
  clickupStaleSince,
  clickupBundleAgeMs,
  storeOk,
  storeReason,
  onDirectoryRefreshed,
}: {
  children: ReactNode;
  /** false once a dashboard payload reports the ClickUp directory bundle is not
   *  live (label-fallback enrollment in effect); null/undefined = unknown yet. */
  clickupLive?: boolean | null;
  /** One-line reason the directory is not live (HTTP status / error class /
   *  unconfigured token) from the dashboard payload; shown under the outage
   *  banner so "unreachable" is never opaque (Task #3655). */
  clickupReason?: string | null;
  /** ISO time of the ClickUp bundle's last successful fetch when it is older
   *  than the staleness threshold (slow/partial ClickUp, not an outright
   *  outage); null/undefined = fresh or unknown. The outage banner wins. */
  clickupStaleSince?: string | null;
  /** Age of the ClickUp directory bundle in ms from the dashboard payload;
   *  when it exceeds the 10-min directory TTL the topbar shows a "Reload
   *  directory" button (Task #3609). null/undefined = unknown, no button. */
  clickupBundleAgeMs?: number | null;
  /** false once a dashboard payload reports the Ads OS jsonb store (pacing /
   *  hygiene / criteria docs) is structurally broken — missing tables or
   *  persistent failures. Blank overlay columns then have a KNOWN cause and
   *  the banner says so (Task #3706). null/undefined = unknown, no banner. */
  storeOk?: boolean | null;
  /** Operator-facing explanation for the store outage (from the payload). */
  storeReason?: string | null;
  /** Called after a successful manual directory refresh so the page can
   *  force-rebuild its payload with the fresh enrollment. */
  onDirectoryRefreshed?: () => void;
}) {
  const [location] = useLocation();
  const { user } = useAuth();
  const [dirReloading, setDirReloading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [clients, setClients] = useState<ClientRef[]>([]);
  const [accounts, setAccounts] = useState<MonitoredAccount[]>([]);
  const [lsaAccounts, setLsaAccounts] = useState<MonitoredAccount[]>([]);

  // CEO-only tab visibility (Task #4375) — mirrors the server's requireCeo on
  // /api/ads-os/proofs/*. `user` is null until the auth probe resolves, so the
  // gate fails closed (tab briefly absent rather than briefly leaked).
  const isCeo = user?.role === "ceo";
  const visibleTabs = TABS.filter((t) => !t.ceoOnly || isCeo);

  // ⌘K / Ctrl-K toggles the palette from anywhere in the module.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Directory pools for the palette, loaded on first open (session-cached in
  // dirPools; best-effort per pool — one failing list still leaves the rest
  // searchable, and pages remain navigable).
  useEffect(() => {
    if (!paletteOpen) return;
    let live = true;
    clientPool().then((c) => live && setClients(c)).catch(() => {});
    gadsPool().then((a) => live && setAccounts(a)).catch(() => {});
    lsaPool().then((a) => live && setLsaAccounts(a)).catch(() => {});
    return () => {
      live = false;
    };
  }, [paletteOpen]);

  // Task #4977: the manual directory reload POSTs a CEO-only endpoint —
  // hide the button for non-CEO viewers (read-only experience).
  const showReload =
    isCeo && typeof clickupBundleAgeMs === "number" && clickupBundleAgeMs > DIR_RELOAD_AFTER_MS;

  async function reloadDirectory() {
    setDirReloading(true);
    setDirError(null);
    try {
      await api.refreshDirectory();
      onDirectoryRefreshed?.();
    } catch (e: any) {
      setDirError(e?.message ?? "Directory refresh failed");
    } finally {
      setDirReloading(false);
    }
  }

  return (
    <div className="ads-os">
      <header className="topbar">
        <Link href="/ads-os" className="brand" aria-label="Go to Main Dashboard">
          {/* Logo and "NoBull Marketing" wordmark removed (task #4819): the
              NBM OS global nav above already carries the brand identity;
              showing it again here created a duplicate bull + wordmark
              directly under the global nav. Only the module label stays. */}
          <span className="brand-title">Ads OS</span>
        </Link>
        <div className="topbar-right">
          <button
            type="button"
            className="cmdk-trigger"
            onClick={() => setPaletteOpen(true)}
            title="Jump to a client, account or page (⌘K)"
            data-testid="button-cmdk-trigger"
          >
            <span aria-hidden="true">⌕</span> Jump to… <kbd>⌘K</kbd>
          </button>
          {showReload ? (
            <button
              type="button"
              className="dir-reload-btn"
              onClick={reloadDirectory}
              disabled={dirReloading}
              title="The ClickUp client directory is more than 10 minutes old — reload it to pick up enrollment changes now."
              data-testid="button-reload-directory"
            >
              {dirReloading ? "Reloading…" : "Reload directory"}
            </button>
          ) : null}
          <nav className="tabs">
            {visibleTabs.map((t) => (
              <Link
                key={t.path}
                href={t.path}
                className={location === t.path ? "tab active" : "tab"}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main>
        {dirError ? (
          <div className="banner banner-amber" role="alert" data-testid="banner-directory-reload-error">
            Couldn't refresh the client directory. It usually clears on its own —{" "}
            <button
              type="button"
              className="link"
              onClick={reloadDirectory}
              disabled={dirReloading}
              data-testid="button-directory-reload-retry"
            >
              try again
            </button>
            .
          </div>
        ) : null}
        {storeOk === false ? (
          <div className="banner banner-amber" data-testid="banner-store-outage">
            Ads OS data store unavailable — Budget Pacing, Hygiene and Traffic Quality
            columns are blank because the store can't be read, NOT because the data is
            missing from Google/ClickUp. Criteria saves will fail until it recovers.
            {storeReason ? (
              <div className="banner-detail" data-testid="text-store-reason">
                {storeReason}
              </div>
            ) : null}
          </div>
        ) : null}
        {clickupLive === false ? (
          <div className="banner banner-amber" data-testid="banner-clickup-degraded">
            ClickUp directory unavailable — enrollment is running on the legacy account
            labels (which may be empty now that accounts no longer carry them). Client
            grouping, Doer/Checker and statuses may be incomplete until ClickUp recovers.
            {clickupReason ? (
              <div className="banner-detail" data-testid="text-clickup-reason">
                {clickupReason}
              </div>
            ) : null}
          </div>
        ) : clickupStaleSince ? (
          <div className="banner banner-amber" data-testid="banner-clickup-stale">
            ClickUp is responding slowly — client data (statuses, Doer/Checker) was last
            refreshed {formatStaleSince(clickupStaleSince)} and may be out of date.
          </div>
        ) : null}
        {children}
      </main>
      {paletteOpen && (
        <CommandPalette
          clients={clients}
          accounts={accounts}
          lsaAccounts={lsaAccounts}
          showSystemChecks={isCeo}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
