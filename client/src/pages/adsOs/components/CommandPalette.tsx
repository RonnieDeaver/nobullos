import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { ClientRef, MonitoredAccount } from "../lib/types";
import { matchAccounts, matchClients } from "../lib/accountSearch";

type Item =
  | { kind: "page"; label: string; hint: string; path: string }
  | { kind: "client"; label: string; name: string }
  | { kind: "account"; label: string; cid: string; product: "gads" | "lsa" };

// ⌘K / Ctrl-K jump-to-anything palette. Merges clients (-> their profile), both
// account pools (tagged by product so a both-product client's two CIDs stay distinct),
// plus the dashboards, and navigates with the app router. Full keyboard control.
export function CommandPalette({
  clients,
  accounts,
  lsaAccounts,
  showSystemChecks = false,
  onClose,
}: {
  clients: ClientRef[];
  accounts: MonitoredAccount[];
  lsaAccounts: MonitoredAccount[];
  /** Include the CEO-only System Checks (proofs) page in the jump list —
   *  defaults off so the gate fails closed (Task #4375, audit P3-7). */
  showSystemChecks?: boolean;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = [
      { kind: "page", label: "Main Dashboard", hint: "Overview", path: "/ads-os" },
      { kind: "page", label: "Google Ads", hint: "Dashboard", path: "/ads-os/gads" },
      { kind: "page", label: "LSA", hint: "Dashboard", path: "/ads-os/lsa" },
      ...(showSystemChecks
        ? [{ kind: "page", label: "System Checks", hint: "CEO-only verification", path: "/ads-os/proofs" } as Item]
        : []),
    ];
    const s = q.trim().toLowerCase();
    const pageMatches = s ? pages.filter((p) => p.label.toLowerCase().includes(s)) : pages;
    const clientItems: Item[] = matchClients(clients, q).map((c) => ({
      kind: "client", label: c.name, name: c.name,
    }));
    const gads: Item[] = matchAccounts(accounts, q).map((a) => ({
      kind: "account", label: a.descriptive_name, cid: a.customer_id, product: "gads",
    }));
    const lsa: Item[] = matchAccounts(lsaAccounts, q).map((a) => ({
      kind: "account",
      label: a.city ? `${a.descriptive_name} · ${a.city}` : a.descriptive_name,
      cid: a.customer_id,
      product: "lsa",
    }));
    return [...pageMatches, ...clientItems, ...gads, ...lsa].slice(0, 50);
  }, [q, clients, accounts, lsaAccounts, showSystemChecks]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  function activate(i: number) {
    const it = items[i];
    if (!it) return;
    onClose();
    if (it.kind === "page") setLocation(it.path);
    else if (it.kind === "client") setLocation(`/ads-os/client/${encodeURIComponent(it.name)}`);
    else
      setLocation(
        it.product === "lsa" ? `/ads-os/lsa/a/${it.cid}/hygiene` : `/ads-os/a/${it.cid}/audit`
      );
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="cmdk-backdrop">
      <div className="cmdk" ref={boxRef} role="dialog" aria-modal="true" aria-label="Jump to client, account, or page">
        <div className="cmdk-search-row">
          <span className="cmdk-icon" aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Jump to a client, account or page…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            aria-label="Search clients, accounts and pages"
            data-testid="input-cmdk"
          />
          <span className="cmdk-esc">esc</span>
        </div>
        <ul className="cmdk-list" role="listbox">
          {items.map((it, i) => (
            <li
              key={
                it.kind +
                (it.kind === "account" ? it.product + it.cid : it.kind === "client" ? it.name : it.label)
              }
            >
              <button
                ref={i === sel ? activeRef : undefined}
                className={`cmdk-item${i === sel ? " on" : ""}`}
                role="option"
                aria-selected={i === sel}
                onMouseEnter={() => setSel(i)}
                onClick={() => activate(i)}
              >
                <span className="cmdk-label">{it.label}</span>
                {it.kind === "account" ? (
                  <span className={`cmb-tag ${it.product === "gads" ? "g" : "l"}`}>
                    {it.product === "gads" ? "GAds" : "LSA"}
                  </span>
                ) : it.kind === "client" ? (
                  <span className="cmdk-hint">Client</span>
                ) : (
                  <span className="cmdk-hint">{it.hint}</span>
                )}
              </button>
            </li>
          ))}
          {items.length === 0 && (
            <li className="muted pad" role="status" data-testid="text-cmdk-no-results">
              {q.trim()
                ? `No dashboards, tools or clients match “${q.trim()}”. Try a shorter or different term.`
                : "Type to search dashboards, tools and clients."}
            </li>
          )}
        </ul>
        <div className="cmdk-foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span style={{ marginLeft: "auto" }}>Jump from any screen · ⌘K</span>
        </div>
      </div>
    </div>
  );
}
