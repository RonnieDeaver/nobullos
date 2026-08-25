/**
 * Ads OS · Client profile (/ads-os/client/:name) — one client's whole world on a
 * page: identity + budget context in the maroon hero (performance KPIs live in
 * the Performance section below, following its date-range selector), per-account
 * budget pacing, the latest hygiene summaries, GAds traffic quality, the AI
 * summary of the client log, and per-account tool links. Data comes pre-assembled
 * from /api/ads-os/client/profile; the log summary loads separately so a slow
 * Sheets/OpenAI call never delays the page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { Link, useLocation, useRoute } from "wouter";
import { api } from "./lib/api";
import { useIsCeo } from "./lib/useIsCeo";
import type {
  ClientLogSummary,
  ClientProfile as ClientProfileData,
  ClientRef,
  ProfileHygiene,
  ProfilePacingRow,
  ProfilePyramid,
  ProfileQuality,
} from "./lib/types";
import { AdsOsShell } from "./components/AdsOsShell";
import { AdsStatusChip } from "./components/StatusChip";
import { CriteriaEditor } from "./components/CriteriaEditor";
import { PerformanceSection } from "./components/PerformanceSection";
import { matchClients } from "./lib/accountSearch";
import { accountShortLabel, accountTagIsEcho, firstName, formatId, money } from "./lib/format";
import { paceClass } from "./lib/pace";
import { ClientAlertMenu } from "./components/ClientAlertMenu";

export default function ClientProfilePage() {
  const [, params] = useRoute("/ads-os/client/:name");
  const name = params?.name ? decodeURIComponent(params.name) : "";
  const [clients, setClients] = useState<ClientRef[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [staleSince, setStaleSince] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    api
      .clients()
      .then((r) => {
        setClients(r.clients);
        setLive(r.clickup_live);
        setReason(r.clickup_reason ?? null);
        setStaleSince(r.clickup_stale_since ?? null);
      })
      .catch(() => setClients([]));
  }, []);

  return (
    <AdsOsShell clickupLive={live} clickupReason={reason} clickupStaleSince={staleSince}>
      <ClientProfile name={name} clients={clients} />
    </AdsOsShell>
  );
}

// Client switcher for the profile breadcrumb — hop straight to another client's profile
// without going back to the Main Dashboard (the profile's analog of the tool pages'
// account switcher). Falls back to a plain bold name until the client list has loaded.
function ClientSwitcher({ current, clients }: { current: string; clients: ClientRef[] }) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const filtered = useMemo(() => matchClients(clients, q), [clients, q]);
  const norm = (s: string) => s.trim().toLowerCase();
  if (clients.length === 0) return <b>{current}</b>;
  return (
    <span className="crumb-acct" ref={boxRef}>
      <button
        className="crumb-acct-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Switch client"
        data-testid="button-client-switcher"
      >
        {current} <span className="crumb-caret">▾</span>
      </button>
      {open && (
        <div className="crumb-menu">
          <input
            autoFocus
            className="crumb-search"
            placeholder="Switch client…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul>
            {filtered.map((c) => (
              <li key={c.name}>
                <button
                  className={norm(c.name) === norm(current) ? "active" : ""}
                  onClick={() => {
                    setOpen(false);
                    setQ("");
                    setLocation(`/ads-os/client/${encodeURIComponent(c.name)}`);
                  }}
                >
                  <span className="ca-name">{c.name}</span>
                  {(c.has_gads || c.has_lsa) && (
                    <span className="ca-id">
                      {c.has_gads && c.has_lsa ? "GAds + LSA" : c.has_gads ? "GAds" : "LSA"}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="muted pad">No matches</li>}
          </ul>
        </div>
      )}
    </span>
  );
}

export function ClientProfile({ name, clients = [] }: { name: string; clients?: ClientRef[] }) {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<ClientProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logSum, setLogSum] = useState<ClientLogSummary | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  // Which account's criteria the editor is open for (criteria docs are stored PER
  // ACCOUNT, so each Tools row offers its own editor; the hero button targets the
  // primary account).
  const isCeo = useIsCeo();
  const [criteriaFor, setCriteriaFor] = useState<{ customer_id: string; name: string } | null>(
    null
  );

  useEffect(() => {
    setData(null);
    setError(null);
    api.clientProfile(name).then(setData).catch((e) => setError(e.message));
  }, [name]);

  useEffect(() => {
    setLogSum(null);
    api
      .clientLogSummary(name)
      .then(setLogSum)
      .catch(() => setLogSum({ state: "fetch_failed" }));
  }, [name]);

  function regenerateLog() {
    setLogBusy(true);
    api
      .clientLogSummary(name, true)
      .then(setLogSum)
      .catch(() => setLogSum({ state: "fetch_failed" }))
      .finally(() => setLogBusy(false));
  }

  if (error) return <div className="panel error">Couldn’t load client profile: {error}</div>;
  if (!data)
    return (
      <div className="panel loading">
        <div className="spinner" />
        Loading {name}…
      </div>
    );

  const cur = data.currency_code ?? "";
  const tag = data.has_gads && data.has_lsa ? "GAds + LSA" : data.has_gads ? "GAds" : "LSA";
  // Pacing rows share the Performance section's short-label convention; the sole-GAds
  // collapse ("GAds" instead of the store name) hinges on this count.
  const pacingGadsCount = data.pacing.rows.filter((r) => r.product === "gads").length;
  // The Hygiene section shares the same short-label convention; its sole-GAds
  // collapse counts the GAds accounts among the hygiene rows themselves.
  const hygieneGadsCount = data.hygiene.filter((h) => h.product === "gads").length;
  const audited = data.hygiene.filter((h) => h.score !== null);
  const notAudited = data.hygiene.filter((h) => h.score === null);
  // Guarded (?? []) so a stale pre-feature payload during a rolling deploy can't crash the page.
  const pyramidRun = (data.pyramid ?? []).filter((p) => p.action_counts);
  const pyramidNotRun = (data.pyramid ?? []).filter((p) => !p.action_counts);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: motionSafeScrollBehavior() });

  return (
    <div className="cp" data-testid="page-ads-os-client">
      <div className="cp-crumbs">
        <Link href="/ads-os">Main Dashboard</Link> › <ClientSwitcher current={data.client} clients={clients} />
      </div>

      {/* ═══ Hero ═══ */}
      <header className="cp-hero">
        <div className="cp-hero-main">
          <div>
            <h1>{data.client}</h1>
            <div className="cp-meta">
              <span className="cp-htag">{tag}</span>
              <span>
                {data.accounts.length} account{data.accounts.length === 1 ? "" : "s"}
              </span>
              {data.doer && (
                <>
                  <span className="cp-hdot">•</span>
                  <span>
                    Doer <b>{firstName(data.doer)}</b>
                  </span>
                </>
              )}
              {data.checker && (
                <>
                  <span className="cp-hdot">•</span>
                  <span>
                    Checker <b>{firstName(data.checker)}</b>
                  </span>
                </>
              )}
            </div>
            <div className="cp-meta">
              <ClientAlertMenu
                summary={data.alerts}
                client={data.client}
                variant="profile"
                testId="button-alerts-chip"
              />
              {data.pacing.combined && (
                <span>
                  Combined budget <b>{money(data.pacing.combined.budget, cur)}/mo</b>
                </span>
              )}
              {/* Compact month-to-date pace at a glance — the detail (per-account bars,
                  recommendations) lives in the Budget pacing section this jumps to. */}
              {data.pacing.combined && data.pacing.combined.pace_pct !== null && (
                <button
                  className={`bp-pill ${data.pacing.combined.budget_hit ? "hit" : paceClass(data.pacing.combined.pace_pct)}`}
                  onClick={() => jump("cp-pacing")}
                  title={
                    data.pacing.combined.budget_hit
                      ? "Monthly budget hit — see Budget pacing below"
                      : "Month-to-date budget pace — see Budget pacing below"
                  }
                  data-testid="button-hero-pace"
                >
                  {data.pacing.combined.budget_hit
                    ? "MBH"
                    : `${data.pacing.combined.pace_pct > 0 ? "+" : ""}${Math.round(data.pacing.combined.pace_pct)}% pace`}
                </button>
              )}
            </div>
            <div className="cp-hero-actions">
              {data.criteria_account && (
                <button
                  className="cp-hbtn primary"
                  onClick={() => setCriteriaFor(data.criteria_account)}
                  data-testid="button-client-criteria"
                >
                  Client criteria
                </button>
              )}
              {data.log_url && (
                <a className="cp-hbtn" href={data.log_url} target="_blank" rel="noreferrer" data-testid="link-open-client-log">
                  Open client log ↗
                </a>
              )}
            </div>
          </div>
        </div>
        <nav className="cp-hero-nav" aria-label="Jump to section">
          <button onClick={() => jump("cp-performance")}>Performance</button>
          <button onClick={() => jump("cp-pacing")}>Budget pacing</button>
          <button onClick={() => jump("cp-hygiene")}>Hygiene</button>
          <button onClick={() => jump("cp-pyramid")}>Pyramid review</button>
          <button onClick={() => jump("cp-quality")}>Traffic quality</button>
          <button onClick={() => jump("cp-log")}>Recent optimizations</button>
          <button onClick={() => jump("cp-tools")}>Tools</button>
        </nav>
      </header>

      {/* ═══ Performance (spend / leads / CPL over time) ═══ */}
      <PerformanceSection name={data.client} />

      {/* ═══ Budget pacing ═══ */}
      <section className="cp-card" id="cp-pacing">
        <div className="cp-card-h">
          <h2>Budget pacing</h2>
          <span className="meta">month-to-date · overlaid live from the pacing stores</span>
        </div>
        <div className="cp-pgrid">
          <div className="hcell">Account</div>
          <div className="hcell num">Budget</div>
          <div className="hcell num">MTD spend</div>
          <div className="hcell">Progress to month-end</div>
          <div className="hcell num">Pace</div>
          <div className="hcell num">Rec. budget</div>
          {data.pacing.rows.map((r) => (
            <PacingCells
              key={`${r.product}-${r.customer_id}`}
              r={r}
              cur={cur}
              gadsCount={pacingGadsCount}
            />
          ))}
          {data.pacing.combined && data.pacing.rows.length > 1 && (
            <CombinedCells c={data.pacing.combined} cur={cur} />
          )}
        </div>
      </section>

      <div className="cp-cols">
        <div className="cp-stack">
          {/* ═══ Hygiene ═══ */}
          <section className="cp-card" id="cp-hygiene">
            <div className="cp-card-h">
              <h2>Hygiene — latest audits</h2>
              <span className="meta">summary of each account’s most recent report</span>
            </div>
            {audited.map((h) => (
              <HygieneBlock key={`${h.product}-${h.customer_id}`} h={h} gadsCount={hygieneGadsCount} />
            ))}
            {audited.length === 0 && (
              <div className="cp-note">No audits have been run for this client yet.</div>
            )}
            {notAudited.length > 0 && (
              <div className="cp-chiprow">
                {notAudited.map((h) => (
                  <button
                    key={`${h.product}-${h.customer_id}`}
                    className="cp-chip run"
                    onClick={() => setLocation(hygienePath(h))}
                  >
                    {accountShortLabel(h, hygieneGadsCount)} — Run audit
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* ═══ Recent optimizations (AI log summary) ═══ */}
          <section className="cp-card" id="cp-log">
            <div className="cp-card-h">
              <h2>Recent optimizations</h2>
              <span className="cp-ai-badge">AI summary</span>
              <span className="meta">from the client log · last 30 days</span>
            </div>
            <LogSection
              sum={logSum}
              busy={logBusy}
              logUrl={data.log_url}
              onRegenerate={regenerateLog}
              canRegenerate={isCeo /* Task #4977: forced regen runs Sheets+AI and persists — CEO-only */}
            />
          </section>
        </div>

        <div className="cp-stack">
          {/* ═══ Pyramid Breakdown (latest AI campaign review) ═══ */}
          <section className="cp-card" id="cp-pyramid">
            <div className="cp-card-h">
              <h2>Pyramid Breakdown</h2>
              <span className="cp-ai-badge">AI review</span>
              <span className="meta">latest campaign performance review</span>
            </div>
            {data.has_gads ? (
              <>
                {pyramidRun.map((p) => (
                  <PyramidBlock key={p.customer_id} p={p} cur={cur} />
                ))}
                {pyramidRun.length === 0 && (
                  <div className="cp-note">
                    No Pyramid review has been run for this client yet.
                  </div>
                )}
                {pyramidNotRun.length > 0 && (
                  <div className="cp-chiprow">
                    {pyramidNotRun.map((p) => (
                      <button
                        key={p.customer_id}
                        className="cp-chip run"
                        onClick={() => setLocation(`/ads-os/a/${p.customer_id}/pyramid`)}
                      >
                        {p.name} — Run review
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="cp-note">
                No Google Ads account — the Pyramid Breakdown reviews Google Ads campaigns.
              </div>
            )}
          </section>

          {/* ═══ Traffic quality ═══ */}
          <section className="cp-card" id="cp-quality">
            <div className="cp-card-h">
              <h2>Traffic quality</h2>
              <span className="meta">Google Ads</span>
            </div>
            {data.quality.length > 0 ? (
              data.quality.map((q) => <QualityGauge key={q.customer_id} q={q} />)
            ) : data.has_gads ? (
              <div className="cp-note">
                Run the{" "}
                <Link href={`/ads-os/a/${gadsCid(data)}/analyzer/negatives`}>Search Term Analyzer</Link> to
                capture this client’s traffic quality.
              </div>
            ) : (
              <div className="cp-note">No Google Ads account — LSA has no traffic-quality score.</div>
            )}
          </section>

          {/* ═══ Tools ═══ */}
          <section className="cp-card" id="cp-tools">
            <div className="cp-card-h">
              <h2>Tools</h2>
              <span className="meta">per account</span>
            </div>
            {data.accounts.map((a) => (
              <div className="cp-tool-row" key={`${a.product}-${a.customer_id}`}>
                <span className="nm">
                  <span className={`cmb-tag ${a.product === "gads" ? "g" : "l"}`}>
                    {a.product === "gads" ? "GAds" : "LSA"}
                  </span>
                  {a.product === "lsa" && a.city ? a.city : a.name}
                  {/* Shared with the AM Dashboard (Task #3989): the chip's mark is the
                      morning Paused/Off verification's ✓/✗ from the profile payload. */}
                  <AdsStatusChip status={a.ads_status} check={a.status_check ?? null} product={a.product} accountName={a.name} />
                  {/* Task #4964: active campaigns, zero monitor labels — every
                      label-scoped metric for this account reads $0.00 until the
                      label is applied. Distinct from Paused/Off and from a
                      metrics-fetch failure. */}
                  {a.zero_label && (
                    <span
                      className="cmb-setup"
                      title="Active campaigns but no NBM_GADS_MONITOR_CAMPAIGN labels — Ads OS metrics read $0.00 until the monitor label is applied (production actions panel: “Apply Ads OS monitor labels”)."
                      data-testid={`chip-setup-needed-${a.customer_id}`}
                    >
                      Setup needed — no labeled campaigns
                    </span>
                  )}
                  <span className="cp-cid tnum">{formatId(a.customer_id)}</span>
                </span>
                <span className="cp-tool-links">
                  {a.product === "gads" ? (
                    <>
                      <Link className="cmb-link" href={`/ads-os/a/${a.customer_id}/audit`}>Hygiene</Link>
                      <Link className="cmb-link" href={`/ads-os/a/${a.customer_id}/analyzer/negatives`}>Analyzer</Link>
                      <Link className="cmb-link" href={`/ads-os/a/${a.customer_id}/pacing`}>Pacing</Link>
                      <Link className="cmb-link" href={`/ads-os/a/${a.customer_id}/pyramid`}>Pyramid</Link>
                    </>
                  ) : (
                    <>
                      <Link className="cmb-link" href={`/ads-os/lsa/a/${a.customer_id}/hygiene`}>Hygiene</Link>
                      <Link className="cmb-link" href={`/ads-os/lsa/a/${a.customer_id}/pacing`}>Pacing</Link>
                    </>
                  )}
                  <button
                    className="cmb-link"
                    onClick={() =>
                      setCriteriaFor({
                        customer_id: a.customer_id,
                        name: a.city ? `${a.name} · ${a.city}` : a.name,
                      })
                    }
                    title="Edit this account's criteria"
                  >
                    Criteria
                  </button>
                </span>
              </div>
            ))}
          </section>
        </div>
      </div>

      {criteriaFor && (
        <CriteriaEditor
          account={{
            customer_id: criteriaFor.customer_id,
            descriptive_name: criteriaFor.name,
          }}
          onClose={() => setCriteriaFor(null)}
          onSaved={() => setCriteriaFor(null)}
        />
      )}
    </div>
  );
}

function gadsCid(data: ClientProfileData): string {
  return data.accounts.find((a) => a.product === "gads")?.customer_id ?? "";
}

function hygienePath(h: ProfileHygiene): string {
  return h.product === "gads"
    ? `/ads-os/a/${h.customer_id}/audit`
    : `/ads-os/lsa/a/${h.customer_id}/hygiene`;
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// One pacing table row (6 grid cells). No configured budget -> quiet dashes.
function PacingCells({
  r,
  cur,
  gadsCount,
}: {
  r: ProfilePacingRow;
  cur: string;
  gadsCount: number;
}) {
  const hasBudget = r.budget !== null && r.budget > 0;
  const fill = hasBudget ? Math.min(r.used_pct ?? 0, 100) : 0;
  const mark = hasBudget && r.expected_pct !== null ? Math.min(Math.max(r.expected_pct, 0), 100) : null;
  const tone = r.budget_hit ? "b" : r.pace_pct !== null ? paceClass(r.pace_pct) : "g";
  // The pace pill links to this account's own budget-pacing page.
  const paceHref =
    r.product === "gads" ? `/ads-os/a/${r.customer_id}/pacing` : `/ads-os/lsa/a/${r.customer_id}/pacing`;
  return (
    <>
      <div className="cell">
        <div className="cp-acct">
          <span className="nm">
            {accountShortLabel(r, gadsCount)}
            {/* Sole-GAds rows are already labeled "GAds" — no tag echo. */}
            {!accountTagIsEcho(r, gadsCount) && (
              <span className={`cmb-tag ${r.product === "gads" ? "g" : "l"}`}>
                {r.product === "gads" ? "GAds" : "LSA"}
              </span>
            )}
          </span>
          <span className="cid tnum">{formatId(r.customer_id)}</span>
        </div>
      </div>
      <div className="cell num m tnum">{hasBudget ? money(r.budget!, cur) : "—"}</div>
      <div className="cell num m tnum">{r.mtd !== null ? money(r.mtd, cur) : "—"}</div>
      <div className="cell">
        {hasBudget ? (
          <div className="cp-bar-wrap">
            {r.used_pct !== null && <span className="pct tnum">{Math.round(r.used_pct)}%</span>}
            <div className="cp-bar">
              <i className={tone} style={{ width: `${fill}%` }} />
              {mark !== null && <span className="mark" style={{ left: `${mark}%` }} />}
            </div>
          </div>
        ) : (
          <span className="cp-note">No budget configured in ClickUp</span>
        )}
      </div>
      <div className="cell num">
        {r.budget_hit ? (
          <Link className="bp-pill hit" href={paceHref} title="Open budget pacing">MBH</Link>
        ) : r.pace_pct !== null ? (
          <Link className={`bp-pill ${paceClass(r.pace_pct)}`} href={paceHref} title="Open budget pacing">
            {r.pace_pct > 0 ? "+" : ""}
            {Math.round(r.pace_pct)}%
          </Link>
        ) : (
          <span className="cp-note">—</span>
        )}
      </div>
      <div className="cell num m tnum">
        {r.recommended !== null ? (
          <>
            {money(r.recommended, cur)}
            <small>per {r.recommended_per}</small>
          </>
        ) : (
          "—"
        )}
      </div>
    </>
  );
}

function CombinedCells({
  c,
  cur,
}: {
  c: NonNullable<ClientProfileData["pacing"]["combined"]>;
  cur: string;
}) {
  const fill = Math.min(c.used_pct ?? 0, 100);
  const mark = c.expected_pct !== null ? Math.min(Math.max(c.expected_pct, 0), 100) : null;
  const tone = c.budget_hit ? "b" : c.pace_pct !== null ? paceClass(c.pace_pct) : "g";
  return (
    <>
      <div className="cell total">
        <div className="cp-acct">
          <span className="nm">Combined</span>
        </div>
      </div>
      <div className="cell total num m tnum">{money(c.budget, cur)}</div>
      <div className="cell total num m tnum">{money(c.mtd, cur)}</div>
      <div className="cell total">
        <div className="cp-bar-wrap">
          {c.used_pct !== null && <span className="pct tnum">{Math.round(c.used_pct)}%</span>}
          <div className="cp-bar">
            <i className={tone} style={{ width: `${fill}%` }} />
            {mark !== null && <span className="mark" style={{ left: `${mark}%` }} />}
          </div>
        </div>
      </div>
      <div className="cell total num">
        {c.budget_hit ? (
          <span className="bp-pill hit">MBH</span>
        ) : c.pace_pct !== null ? (
          <span className={`bp-pill ${paceClass(c.pace_pct)}`}>
            {c.pace_pct > 0 ? "+" : ""}
            {Math.round(c.pace_pct)}%
          </span>
        ) : (
          <span className="cp-note">—</span>
        )}
      </div>
      <div className="cell total num" />
    </>
  );
}

function scoreTier(score: number): string {
  return score >= 75 ? "g" : score >= 60 ? "w" : "b";
}

function HygieneBlock({ h, gadsCount }: { h: ProfileHygiene; gadsCount: number }) {
  const reportHref =
    h.product === "gads" ? `/ads-os/a/${h.customer_id}/audit` : `/ads-os/lsa/a/${h.customer_id}/hygiene`;
  const ns = h.next_steps;
  return (
    <div className="cp-hy-block">
      <div className="cp-hy-head">
        {!accountTagIsEcho(h, gadsCount) && (
          <span className={`cmb-tag ${h.product === "gads" ? "g" : "l"}`}>
            {h.product === "gads" ? "GAds" : "LSA"}
          </span>
        )}
        <span className="nm">{accountShortLabel(h, gadsCount)}</span>
        {h.score !== null && (
          <>
            <span className={`cp-score ${scoreTier(h.score)}`}>{Math.round(h.score)}</span>
            {h.band && <span className={`cp-band ${scoreTier(h.score)}`}>{h.band}</span>}
          </>
        )}
        <span className="cp-hy-meta">
          {h.at ? `run ${shortDate(h.at)}` : ""}
          <Link className="cmb-link" href={reportHref}>Full report</Link>
        </span>
      </div>
      {ns ? (
        <div className="cp-tasks">
          <TaskCol tone="crit" label="Critical" items={ns.critical} count={ns.counts.critical} />
          <TaskCol tone="imp" label="Important" items={ns.important} count={ns.counts.important} />
          <TaskCol tone="low" label="Less important" items={ns.minor} count={ns.counts.minor} />
        </div>
      ) : (
        <div className="cp-note" style={{ marginTop: 10 }}>
          The task summary appears after the next audit run.
        </div>
      )}
    </div>
  );
}

// One GAds account's latest Pyramid Breakdown snapshot: action-count chips (the
// tool's own chip styles), the money headlines, and the run's top recommendations.
const PYR_ACTION_LABEL: Record<string, string> = {
  scale: "Scale",
  keep: "Keep",
  watch: "Watch",
  throttle: "Throttle",
  pause: "Pause",
};

function PyramidBlock({ p, cur }: { p: ProfilePyramid; cur: string }) {
  const counts = p.action_counts ?? {};
  const recs = (p.top_recommendations ?? []).slice(0, 4);
  return (
    <div className="cp-pyr-block">
      <div className="cp-hy-head">
        <span className="cmb-tag g">GAds</span>
        <span className="nm">{p.name}</span>
        <span className="cp-hy-meta">
          {p.at ? `run ${shortDate(p.at)}` : ""}
          <Link className="cmb-link" href={`/ads-os/a/${p.customer_id}/pyramid`}>Full report</Link>
        </span>
      </div>
      <div className="cp-pyr-chips">
        {(["scale", "keep", "watch", "throttle", "pause"] as const).map((a) =>
          counts[a] ? (
            <span key={a} className={`pyr-chip a-${a}`}>
              {PYR_ACTION_LABEL[a]} {counts[a]}
            </span>
          ) : null
        )}
        {p.ai_status === "rules_only" && (
          <span className="cp-pyr-flag" title="OpenAI wasn't available for this run — checklist rules only.">
            rules-only run
          </span>
        )}
      </div>
      <div className="cp-pyr-stats">
        {p.flagged_keywords ? (
          <>
            <b>{p.flagged_keywords}</b> killer keyword{p.flagged_keywords === 1 ? "" : "s"} ·{" "}
            {money(p.flagged_keyword_cost ?? 0, cur)} spent
          </>
        ) : (
          "No killer keywords"
        )}
        {/* Rules-only runs never scored terms — a "$0 irrelevant" there would read
            as clean traffic rather than "not measured". */}
        {p.irrelevant_term_cost !== null && p.ai_status !== "rules_only" && (
          <> · {money(p.irrelevant_term_cost, cur)} on irrelevant searches</>
        )}
      </div>
      {recs.length > 0 && (
        <ul className="cp-pyr-recs">
          {recs.map((r, i) => (
            <li key={i}>
              <span className={`pyr-chip a-${r.action}`}>
                {PYR_ACTION_LABEL[r.action] ?? r.action}
              </span>
              <span className="t">
                <b>{r.name}</b>
                {r.rationale ? ` — ${r.rationale}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskCol({
  tone,
  label,
  items,
  count,
}: {
  tone: "crit" | "imp" | "low";
  label: string;
  items: { title: string; detail: string }[];
  count: number;
}) {
  return (
    <div className={`cp-tcol ${tone}`}>
      <h4>
        {label} <span className="n">{count}</span>
      </h4>
      {items.length === 0 ? (
        <div className="none">Nothing {tone === "crit" ? "critical" : "here"}</div>
      ) : (
        <ul>
          {items.map((it, i) => (
            <li key={i} title={it.detail || undefined}>
              {it.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QualityGauge({ q }: { q: ProfileQuality }) {
  if (q.score === null) return null;
  const C = 2 * Math.PI * 52; // r=52 circle circumference
  const offset = C * (1 - Math.min(Math.max(q.score, 0), 100) / 100);
  const color = q.score >= 90 ? "var(--green)" : q.score >= 70 ? "var(--yellow)" : "var(--red)";
  const textCls = q.score >= 90 ? "g" : q.score >= 70 ? "w" : "b";
  return (
    <div className="cp-tq">
      <div className="cp-gauge">
        <svg viewBox="0 0 120 120" width="128" height="128" aria-hidden="true">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--track)" strokeWidth="11" />
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke={color}
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={`${C} ${C}`}
            strokeDashoffset={offset}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="in">
          <b className={`tnum ${textCls}`}>{Math.round(q.score)}%</b>
          <span>quality</span>
        </div>
      </div>
      <p>
        {q.score >= 100
          ? "No wasteful search terms in the last analysis — every analyzed dollar went to relevant traffic."
          : `${Math.round(100 - q.score)}% of analyzed spend went to wasteful search terms — review the Analyzer's negatives.`}
      </p>
      <span className="when tnum">
        {q.window_days ? `${q.window_days}-day window` : ""}
        {q.at ? ` · captured ${shortDate(q.at)}` : ""}
      </span>
      <Link className="cmb-link" href={`/ads-os/a/${q.customer_id}/analyzer/negatives`}>
        Review negative keywords
      </Link>
    </div>
  );
}

// Friendly copy for every log-summary state; the raw state codes are backend-facing.
const LOG_STATE_COPY: Record<string, string> = {
  no_log:
    "No client log linked yet — add the sheet link to the “Paid Search Client Log” field on the client’s ClickUp record.",
  no_credentials:
    "Google Sheets sign-in isn’t available in this environment (local dev) — the summary works on the live site.",
  no_access:
    "The app can’t open the log sheet. Share the sheet (view-only) with the app’s service account to enable the summary.",
  api_disabled:
    "Google Sheets access isn’t enabled for the app’s Google Cloud project yet (enable the Google Sheets API).",
  not_found: "The linked log sheet no longer exists (or the link is wrong).",
  tab_missing: "The log sheet has no “Optimizations & Ideas” tab.",
  empty: "The log tab has no entries yet — changes documented there will be summarized here.",
  no_recent: "No entries in the client log for the last 30 days.",
  no_openai: "OpenAI isn’t configured, so the summary can’t be generated.",
  directory_unavailable: "Couldn’t reach ClickUp to look up the client’s log — try again in a minute.",
  client_not_in_directory:
    "This client name doesn’t match any ClickUp Client List task, so its log can’t be found — check the client’s name matches its ClickUp record.",
  fetch_failed: "Couldn’t read the log sheet right now.",
  summarize_failed: "Couldn’t generate the summary right now.",
};

function LogSection({
  sum,
  busy,
  logUrl,
  onRegenerate,
  canRegenerate,
}: {
  sum: ClientLogSummary | null;
  busy: boolean;
  logUrl: string | null;
  onRegenerate: () => void;
  /** Task #4977: regenerate forces a fresh Sheets read + AI summary and
   *  persists it — a CEO-only trigger; read-only staff see the stored copy. */
  canRegenerate: boolean;
}) {
  if (!sum)
    return (
      <div className="cp-note">
        <span className="spinner sm" /> Reading the client log…
      </div>
    );
  const retryable = ["fetch_failed", "summarize_failed", "directory_unavailable"].includes(
    sum.state
  );
  if (sum.state !== "ok")
    return (
      <div className="cp-note">
        {LOG_STATE_COPY[sum.state] ?? "The log summary isn’t available."}
        {retryable && canRegenerate && (
          <button className="cp-ghost" onClick={onRegenerate} disabled={busy}>
            {busy ? "Retrying…" : "Retry"}
          </button>
        )}
        {logUrl && (
          <a className="cmb-link" style={{ marginLeft: 10 }} href={logUrl} target="_blank" rel="noreferrer">
            Open client log ↗
          </a>
        )}
      </div>
    );
  return (
    <>
      {sum.stale && (
        <div className="cp-note" style={{ marginBottom: 10 }}>
          Showing the last saved summary — the refresh didn’t go through (
          {LOG_STATE_COPY[sum.refresh_error ?? ""] ?? sum.refresh_error}).
        </div>
      )}
      <div className="cp-log">
        {(sum.entries ?? []).map((e, i) => (
          <div className="cp-log-row" key={i}>
            <span className="d tnum">{e.date || "—"}</span>
            <span>{e.text}</span>
          </div>
        ))}
        {(sum.entries ?? []).length === 0 && (
          <div className="cp-note">The log had no summarizable entries.</div>
        )}
      </div>
      <div className="cp-ai-foot">
        <span>
          {sum.row_count
            ? `Summarized from ${sum.row_count} log rows · last ${sum.window_days ?? 30} days`
            : "Summarized"}
          {sum.generated_at ? ` · ${shortDate(sum.generated_at)}` : ""}
        </span>
        {logUrl && (
          <a className="cmb-link" href={logUrl} target="_blank" rel="noreferrer">
            Open client log ↗
          </a>
        )}
        {canRegenerate && (
        <button className="cp-ghost" onClick={onRegenerate} disabled={busy} data-testid="button-regenerate-log">
          {busy ? "Regenerating…" : "Regenerate"}
        </button>
        )}
      </div>
    </>
  );
}
