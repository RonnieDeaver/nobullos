// AM Dashboard (/ads-os/am) — one launch card per client, filtered by ads manager.
//
// Port of the reference app's board (Task #3988): the daily entry point into client
// ad accounts, replacing browser bookmarks. Each card carries a direct-launch button
// for every Google Ads / LSA account plus the Client Log; the toolbar filters by Doer
// (the ads manager), Checker and platform, and searches by client name or CID
// (hyphen/space-insensitive, so "6837251501" and "683-725-1501" both match).
//
// The roster is LIVE from the ClickUp directory (new clients appear automatically);
// only the launch URLs come from a captured store, because a working deep link cannot
// be derived from a CID (Google's ocid/cid params are opaque — see amDashboard.ts).
// An account with no captured URL still renders (CID, log, profile all work) with a
// quiet "no launch link yet" marker instead of a guessed URL that could open the
// wrong account.
//
// Filters persist in localStorage AND mirror into the URL query (/ads-os/am?doer=…),
// so a filtered view is shareable — both inherited from the prototype.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { api, ApiError } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type { AmAccount, AmClient, AmDashboardData } from "./lib/types";
import { firstName, formatId } from "./lib/format";
import { AdsStatusChip } from "./components/StatusChip";
import { AdsOsShell } from "./components/AdsOsShell";
import { ClientAlertMenu } from "./components/ClientAlertMenu";
import { EmptyState } from "@/components/kit/EmptyState";
import {
  AM_LS_KEYS,
  amFiltersQuery,
  initialAmFilters,
  resetStalePeople,
  visibleAmClients,
  type AmFilters,
} from "./lib/amFilters";

// ---- filter state <-> localStorage + URL query -----------------------------------

// The semantics (URL-over-localStorage precedence, default omission, the stale
// reset, the visibility pipeline) live in lib/amFilters.ts — pure and gate-
// tested. This file only wires them to location/localStorage/history.

function initialFilters(): AmFilters {
  return initialAmFilters(window.location.search, localStorage);
}

// Mirror the current filters into the URL query without triggering a re-route
// (replaceState) — default values are omitted so the pristine URL stays /ads-os/am.
function writeUrlQuery(f: AmFilters): void {
  history.replaceState(null, "", `/ads-os/am${amFiltersQuery(f)}`);
}

// ---- launch behaviour -------------------------------------------------------------

// GAds links reuse one named tab per account (repeat clicks refocus it instead of
// spawning duplicates); LSA links open plain new tabs. The prototype's timed retry
// hack for Google's MCC context-switch lag is deliberately NOT ported — it depends on
// a pop-up permission and re-opens tabs on a timer; a second click does the same job.
function launchTarget(a: AmAccount): string {
  return a.product === "gads" ? `gads-${a.customer_id}` : "_blank";
}

// "Open all LSA" must open synchronously inside the click handler — staggering with
// setTimeout makes browsers treat the later tabs as unsolicited and silently block
// them (a real bug during the prototype's development). The browser may still ask to
// allow pop-ups once for this site; that is expected first-run behaviour.
function openAll(accounts: AmAccount[]): void {
  for (const a of accounts) {
    if (a.deep_link) window.open(a.deep_link, "_blank", "noopener");
  }
}

// ---- the page ---------------------------------------------------------------------

function AmDashboard() {
  const [data, setData] = useState<AmDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Task #4977: non-CEO staff get a read-only Ads OS — CEO-only trigger/edit
  // controls are hidden and Refresh skips the CEO-only recompute POST.
  const isCeo = useIsCeo();

  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AmFilters>(initialFilters);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    return api
      .amDashboard()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh recomputes the two things this board DISPLAYS but doesn't produce: the
  // account alerts behind the ⚠ badges and the Paused/Off verification behind the
  // chips' ✓/✗. Both otherwise only move on the ~6am cron, so without this a status
  // fixed at 11am reads wrong until tomorrow. The roster itself is re-read either way.
  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    // Task #4977: the recompute POST is CEO-only — for other roles Refresh is
    // a plain reload of the stored overlays (server 403s the POST anyway).
    if (!isCeo) {
      await load();
      setRefreshing(false);
      return;
    }
    try {
      const r = await api.refreshAmDashboard();
      // Each half can fail on its own, and the two failures look identical on screen —
      // a verification that computed but didn't save leaves exactly the bare chips a
      // run that never happened does. Name which half broke instead of letting either
      // read as "all clear".
      const sc = r.status_checks ?? {};
      const SKIP: Record<string, string> = {
        clickup_unavailable:
          "ClickUp was unreachable, so the Paused/Off check was skipped and the previous marks kept.",
        all_errored:
          "Google Ads couldn’t be reached for any Paused/Off account, so the previous marks were kept. Try Refresh again shortly.",
        no_targets: "No accounts are marked Paused or Off, so there was nothing to verify.",
      };
      if (sc.error) {
        setRefreshError(`The Paused/Off check couldn’t run: ${sc.error}`);
      } else if (sc.skipped) {
        setRefreshError(SKIP[sc.skipped] ?? `The Paused/Off check was skipped (${sc.skipped}).`);
      } else if (sc.saved === false) {
        setRefreshError(
          "The Paused/Off check ran but couldn’t be saved, so the chips stay unmarked. Try Refresh again.",
        );
      } else if (r.alerts?.error) {
        setRefreshError(`Statuses were verified, but the alerts couldn’t refresh: ${r.alerts.error}`);
      }
    } catch (e) {
      setRefreshError(
        `Refresh failed — showing the last stored alerts and status checks. ${
          e instanceof ApiError ? e.message : ""
        }`.trim(),
      );
    }
    await load();
    setRefreshing(false);
  }

  // Persist + mirror on every change (search mirrors to the URL but not to storage —
  // a stale saved search on tomorrow's visit would read as "clients disappeared").
  useEffect(() => {
    localStorage.setItem(AM_LS_KEYS.doer, filters.doer);
    localStorage.setItem(AM_LS_KEYS.checker, filters.checker);
    localStorage.setItem(AM_LS_KEYS.gads, filters.gads ? "1" : "0");
    localStorage.setItem(AM_LS_KEYS.lsa, filters.lsa ? "1" : "0");
    writeUrlQuery(filters);
  }, [filters]);

  const set = (patch: Partial<AmFilters>) => setFilters((f) => ({ ...f, ...patch }));

  // A saved filter naming someone no longer in the data must not silently hide every
  // card — reset it to "all" once the payload arrives.
  useEffect(() => {
    if (!data) return;
    setFilters((f) => resetStalePeople(f, data.managers, data.checkers));
  }, [data]);

  // The filtered view: platform switches hide accounts; a client with no remaining
  // visible accounts drops out entirely (prototype behaviour).
  const visible = useMemo(
    () => (data ? visibleAmClients(data.clients, filters) : []),
    [data, filters],
  );

  const accountCount = visible.reduce((n, c) => n + c.accounts.length, 0);
  // Only worth mentioning the missing verification if any account actually claims
  // Paused/Off — an all-On roster has no chips to mark either way.
  const hasStatusChips = useMemo(
    () =>
      !!data &&
      data.clients.some((c) =>
        c.accounts.some((a) => a.ads_status === "paused" || a.ads_status === "off"),
      ),
    [data],
  );
  const missingLinks = useMemo(
    () =>
      data ? data.clients.reduce((n, c) => n + c.accounts.filter((a) => !a.deep_link).length, 0) : 0,
    [data],
  );

  return (
    <div className="amd">
      <div className="amd-toolbar panel">
        <div className="amd-toolbar-row">
          <input
            ref={searchRef}
            className="amd-search"
            type="search"
            placeholder="Search clients or CIDs…"
            aria-label="Search clients or account CIDs"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            data-testid="input-amd-search"
          />
          <div className="perf-ctl">
            <span className="perf-ctl-l">Ads manager</span>
            <select
              className="range-dd"
              value={filters.doer}
              aria-label="Ads manager (Doer)"
              onChange={(e) => set({ doer: e.target.value })}
              data-testid="select-amd-doer"
            >
              <option value="all">All ads managers</option>
              {/* Deduped by first name (the filter's unit): two "Juan …"s would render
                  identical options; one option that matches both books is coherent
                  until the roster actually has a collision worth disambiguating. */}
              {[...new Set((data?.managers ?? []).map(firstName))].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="perf-ctl">
            <span className="perf-ctl-l">Checker</span>
            <select
              className="range-dd"
              value={filters.checker}
              aria-label="Checker"
              onChange={(e) => set({ checker: e.target.value })}
              data-testid="select-amd-checker"
            >
              <option value="all">All checkers</option>
              {[...new Set((data?.checkers ?? []).map(firstName))].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="perf-ctl">
            <span className="perf-ctl-l">Platforms</span>
            <div className="amd-switches" role="group" aria-label="Platforms">
              <button
                type="button"
                className={`amd-switch g${filters.gads ? " on" : ""}`}
                aria-pressed={filters.gads}
                onClick={() => set({ gads: !filters.gads })}
                data-testid="button-amd-gads"
              >
                Google Ads
              </button>
              <button
                type="button"
                className={`amd-switch l${filters.lsa ? " on" : ""}`}
                aria-pressed={filters.lsa}
                onClick={() => set({ lsa: !filters.lsa })}
                data-testid="button-amd-lsa"
              >
                LSA
              </button>
            </div>
          </div>
          <span className="amd-count muted" data-testid="text-amd-count">
            {data
              ? `${visible.length} client${visible.length === 1 ? "" : "s"} · ${accountCount} account${accountCount === 1 ? "" : "s"}`
              : ""}
          </span>
          <button
            type="button"
            className="btn-secondary amd-refresh"
            onClick={() => void refresh()}
            disabled={!data || refreshing}
            title="Re-check every account's alerts and verify the Paused/Off statuses now, instead of waiting for the ~6am run"
            data-testid="button-amd-refresh"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="panel error" data-testid="panel-amd-error">
          Couldn’t load the AM Dashboard: {error}
        </div>
      )}
      {refreshError && (
        <div className="banner banner-amber" data-testid="banner-amd-refresh-error">
          {refreshError}
        </div>
      )}
      {!data && !error && (
        <div className="panel loading">
          <div className="spinner" /> Loading clients…
        </div>
      )}
      {data && !data.clickup_ok && (
        <div className="banner banner-amber" data-testid="banner-amd-clickup-down">
          ClickUp is unreachable right now, so the client roster can’t be built — try again in a
          minute.
        </div>
      )}
      {/* A bare Paused/Off chip means "no verdict", which on screen is indistinguishable
          from "verdict: fine". Say which one it is instead of leaving people to hover. */}
      {data && data.clickup_ok && !data.status_checked_at && hasStatusChips && (
        <div className="banner banner-amber" data-testid="banner-amd-not-verified">
          The Paused and Off statuses haven’t been checked against the accounts yet, so their
          chips carry no ✓ or ✗. This runs automatically each morning — press <b>Refresh</b> to
          run it now.
        </div>
      )}

      {data && data.clickup_ok && visible.length === 0 && (
        <div className="panel amd-empty" data-testid="panel-amd-empty">
          <EmptyState
            title="No clients match these filters"
            description="No client matches the current search, ads-manager, checker and platform filters."
            hint="Broaden the filters — clear the search box or turn a platform switch back on."
            action={
              filters.q ? (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => set({ q: "" })}
                  data-testid="button-clear-am-search"
                >
                  Clear search
                </button>
              ) : undefined
            }
            testId="empty-am-filtered"
          />
        </div>
      )}

      <div className="amd-grid">
        {visible.map((c) => (
          <AmCard key={c.client} c={c} />
        ))}
      </div>

      {data && missingLinks > 0 && (
        <div className="amd-foot muted" data-testid="text-amd-missing-links">
          {missingLinks} account{missingLinks === 1 ? "" : "s"} across the roster{" "}
          {missingLinks === 1 ? "has" : "have"} no launch link yet — a Google Ads / LSA deep link
          can’t be derived from the CID, only captured from the address bar. Paste it into the
          account’s <b>Account Link</b> field on its ClickUp subtask and the button appears here
          automatically.
        </div>
      )}
    </div>
  );
}

function AmCard({ c }: { c: AmClient & { accounts: AmAccount[] } }) {
  const [, setLocation] = useLocation();
  const lsaLinked = c.accounts.filter((a) => a.product === "lsa" && a.deep_link);
  return (
    <div className="amd-card" data-testid={`card-amd-${c.client}`}>
      <div className="amd-card-h">
        <div className="amd-h-top">
          {/* The card title doubles as the jump into the client's Ads OS profile — the
              one thing the bookmarks version couldn't offer. */}
          <button
            className="amd-client"
            onClick={() => setLocation(`/ads-os/client/${encodeURIComponent(c.client)}`)}
            title={`Open ${c.client}'s client profile`}
            data-testid={`button-amd-client-${c.client}`}
          >
            {c.client}
          </button>
          <ClientAlertMenu
            summary={c.alerts}
            client={c.client}
            variant="card"
            testId={`button-amd-alerts-${c.client}`}
          />
        </div>
        <div className="amd-tags">
          {c.doer && (
            <span className="amd-tag">
              Doer: <b>{firstName(c.doer)}</b>
            </span>
          )}
          {c.checker && (
            <span className="amd-tag">
              Checker: <b>{firstName(c.checker)}</b>
            </span>
          )}
        </div>
      </div>

      {/* Body sits inside its own padded wrapper so the header band can run edge to
          edge across the card's full width. */}
      <div className="amd-card-body">
        <div className="amd-accounts">
          {c.accounts.map((a) =>
            a.deep_link ? (
              <a
                key={`${a.product}:${a.customer_id}:${a.label}`}
                className={`amd-acc ${a.product === "gads" ? "g" : "l"}`}
                href={a.deep_link}
                target={launchTarget(a)}
                // No rel on GAds links ON PURPOSE: noopener/noreferrer disables named-
                // target reuse, so every click would spawn a fresh tab instead of
                // refocusing the account's tab. The destination is ads.google.com (both
                // link sources are scheme-validated server-side), so forgoing noopener
                // is safe here; LSA links open plain _blank tabs and keep it.
                rel={a.product === "lsa" ? "noopener noreferrer" : undefined}
                data-testid={`link-amd-acc-${a.product}-${a.customer_id}`}
              >
                <span className="amd-dot" aria-hidden="true" />
                <span className="amd-acc-text">
                  <span className="amd-acc-label">
                    {a.label}
                    {/* interactive={false}: chip sits inside an <a>, so we render a plain
                        <span> with title tooltip to avoid nesting a <button> in an anchor. */}
                    <AdsStatusChip status={a.ads_status} check={a.status_check} product={a.product} interactive={false} />
                  </span>
                  <span className="amd-acc-cid tnum">{formatId(a.customer_id)}</span>
                </span>
                <span className="amd-arrow" aria-hidden="true">
                  ↗
                </span>
              </a>
            ) : (
              <div
                key={`${a.product}:${a.customer_id}:${a.label}`}
                className={`amd-acc nolink ${a.product === "gads" ? "g" : "l"}`}
                title={'No launch link captured for this account yet — fill the "Account Link" field on its ClickUp subtask and the button appears automatically.'}
                data-testid={`row-amd-acc-${a.product}-${a.customer_id}`}
              >
                <span className="amd-dot" aria-hidden="true" />
                <span className="amd-acc-text">
                  <span className="amd-acc-label">
                    {a.label}
                    {/* interactive={false}: same rationale — nolink variant uses a <div>
                        which is not interactive, but keeping both variants consistent. */}
                    <AdsStatusChip status={a.ads_status} check={a.status_check} product={a.product} interactive={false} />
                  </span>
                  <span className="amd-acc-cid tnum">{formatId(a.customer_id)}</span>
                </span>
                <span className="amd-nolink-tag">no link yet</span>
              </div>
            ),
          )}
        </div>

        <div className="amd-card-foot">
          {c.log_url && (
            <a
              className="amd-log"
              href={c.log_url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`link-amd-log-${c.client}`}
            >
              📋 Client Log
            </a>
          )}
          {lsaLinked.length > 1 && (
            <button
              type="button"
              className="amd-openall"
              title={`Open all ${lsaLinked.length} LSA accounts`}
              onClick={() => openAll(lsaLinked)}
              data-testid={`button-amd-openall-${c.client}`}
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 3 8l9 5 9-5-9-5z" />
                <path d="m3 13 9 5 9-5" />
              </svg>
              Open all LSA
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AmDashboardPage() {
  return (
    <AdsOsShell>
      <AmDashboard />
    </AdsOsShell>
  );
}
