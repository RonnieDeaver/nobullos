import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { MonitoredAccount, Product } from "../lib/types";
import { matchAccounts } from "../lib/accountSearch";
import { api } from "../lib/api";
import { gadsPool, lsaPool } from "../lib/dirPools";
import { formatId } from "../lib/format";

/** Which account tool the breadcrumb trail is on (bundle route views). */
export type CrumbView = "audit" | "pacing" | "analyzer" | "pyramid" | "lsa-pacing" | "lsa-hygiene";

type Sibling = { sibling_cid: string; sibling_product: Product };

interface Props {
  view: CrumbView;
  /** Analyzer subview tail ("/negatives" | "/keywords" | "") so switching
   *  accounts lands on the same subview. */
  analyzerSub?: string;
  account: { customer_id: string; descriptive_name: string; city?: string | null };
}

// Main Dashboard › [product dashboard] › [Account ▾ switcher] › Tool — plus the
// "Also: GAds/LSA ↗" pill when the same client runs the other product. Ported
// from the bundle's Breadcrumbs.tsx onto wouter paths; the account pool loads
// from the shared directory pools (same source as the ⌘K palette).
export function Breadcrumbs({ view, analyzerSub = "", account }: Props) {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [accounts, setAccounts] = useState<MonitoredAccount[]>([]);
  const [sibling, setSibling] = useState<Sibling | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const product: Product = view === "lsa-pacing" || view === "lsa-hygiene" ? "lsa" : "gads";

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Switcher pool for the current product (shared session cache; best-effort —
  // the crumb trail works without it, the dropdown just lists nothing).
  useEffect(() => {
    let live = true;
    (product === "lsa" ? lsaPool() : gadsPool())
      .then((a) => {
        if (live) setAccounts(a);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [product]);

  // The same client's account in the other product (GAds <-> LSA), if any.
  useEffect(() => {
    let live = true;
    setSibling(null);
    api
      .clientSibling(account.customer_id)
      .then((s) => {
        if (live && s.sibling_cid && s.sibling_product)
          setSibling({ sibling_cid: s.sibling_cid, sibling_product: s.sibling_product });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [account.customer_id]);

  function goSibling() {
    if (!sibling) return;
    const cid = sibling.sibling_cid;
    if (sibling.sibling_product === "lsa") {
      setLocation(view === "pacing" ? `/ads-os/lsa/a/${cid}/pacing` : `/ads-os/lsa/a/${cid}/hygiene`);
    } else {
      setLocation(view === "lsa-pacing" ? `/ads-os/a/${cid}/pacing` : `/ads-os/a/${cid}/audit`);
    }
  }

  const filtered = useMemo(() => matchAccounts(accounts, q), [accounts, q]);

  const productLabel = product === "lsa" ? "LSA Accounts" : "Accounts";

  function go(cid: string) {
    setOpen(false);
    setQ("");
    if (view === "analyzer") setLocation(`/ads-os/a/${cid}/analyzer${analyzerSub}`);
    else if (view === "pacing") setLocation(`/ads-os/a/${cid}/pacing`);
    else if (view === "lsa-pacing") setLocation(`/ads-os/lsa/a/${cid}/pacing`);
    else if (view === "lsa-hygiene") setLocation(`/ads-os/lsa/a/${cid}/hygiene`);
    else setLocation(`/ads-os/a/${cid}/audit`);
  }

  return (
    <div className="crumbs" data-testid="breadcrumbs">
      <button className="crumb-link" onClick={() => setLocation("/ads-os")}>
        Main Dashboard
      </button>
      <span className="crumb-sep">›</span>
      <button
        className="crumb-link"
        onClick={() => setLocation(product === "lsa" ? "/ads-os/lsa" : "/ads-os/gads")}
      >
        {productLabel}
      </button>
      <span className="crumb-sep">›</span>

      <div className="crumb-acct" ref={boxRef}>
        <button
          className="crumb-acct-btn"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="button-crumb-account"
        >
          {account.descriptive_name}
          {account.city && <span className="dash-city">{account.city}</span>}{" "}
          <span className="crumb-caret">▾</span>
        </button>
        {open && (
          <div className="crumb-menu">
            <input
              autoFocus
              className="crumb-search"
              placeholder="Switch account…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ul>
              {filtered.map((a) => (
                <li key={a.customer_id}>
                  <button
                    className={a.customer_id === account.customer_id ? "active" : ""}
                    onClick={() => go(a.customer_id)}
                  >
                    <span className="ca-name">
                      {a.descriptive_name}
                      {a.city && <span className="dash-city">{a.city}</span>}
                    </span>
                    <span className="ca-id">{formatId(a.customer_id)}</span>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="muted pad" role="status">No accounts match — try a different name or ID.</li>
              )}
            </ul>
          </div>
        )}
      </div>

      <span className="crumb-sep">›</span>

      <span className="crumb-cur">{currentLabel(view)}</span>

      {sibling && (
        <button
          className={`crumb-sibling ${sibling.sibling_product === "gads" ? "g" : "l"}`}
          onClick={goSibling}
          title={`Open this client's ${sibling.sibling_product === "gads" ? "Google Ads" : "LSA"} account`}
          data-testid="button-crumb-sibling"
        >
          Also: {sibling.sibling_product === "gads" ? "GAds" : "LSA"} ↗
        </button>
      )}
    </div>
  );
}

function currentLabel(view: CrumbView): string {
  if (view === "analyzer") return "Search Term Analyzer";
  if (view === "pacing" || view === "lsa-pacing") return "Budget Pacing";
  if (view === "pyramid") return "Pyramid Breakdown";
  return "Hygiene Audit";
}
