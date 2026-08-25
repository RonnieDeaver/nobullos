// AM Dashboard filter state — the pure half (Task #3988).
//
// Everything here is DOM-free so the gate can exercise the exact semantics the
// board ships: URL-vs-localStorage precedence, default omission when mirroring
// back into the URL, the stale-person reset, and the platform → empty-client →
// people → search visibility pipeline. AmDashboard.tsx owns the DOM wiring
// (location, history.replaceState, localStorage) and delegates every decision
// to these functions.

import { firstName } from "./format";
import type { AmAccount, AmClient } from "./types";

export const AM_LS_KEYS = {
  doer: "amd.doer",
  checker: "amd.checker",
  gads: "amd.gads",
  lsa: "amd.lsa",
} as const;

export interface AmFilters {
  doer: string; // "all" | first name
  checker: string;
  gads: boolean;
  lsa: boolean;
  q: string; // search — session-only, never persisted
}

// Initial state: a shared link's query wins over localStorage (last visit). The
// subtlety, inherited from the reference (which parsed its #/am hash — this
// board lives on a real path, so the query comes from location.search): if the
// URL carries ANY query, treat EVERY param as URL-specified (missing = its
// default, never localStorage). The sharer's defaults are omitted from the URL,
// and letting the recipient's saved filters fill them in would show a different
// view than the one that was shared.
export function initialAmFilters(
  search: string,
  store: { getItem(key: string): string | null },
): AmFilters {
  const query = search.startsWith("?") ? search.slice(1) : search;
  const p = new URLSearchParams(query);
  const shared = query.length > 0;
  const str = (key: string, ls: string) =>
    p.get(key) ?? (shared ? "all" : (store.getItem(ls) ?? "all"));
  const bool = (key: string, ls: string) => {
    const v = p.get(key);
    if (v !== null) return v !== "0";
    return shared ? true : store.getItem(ls) !== "0";
  };
  return {
    doer: str("doer", AM_LS_KEYS.doer),
    checker: str("checker", AM_LS_KEYS.checker),
    gads: bool("gads", AM_LS_KEYS.gads),
    lsa: bool("lsa", AM_LS_KEYS.lsa),
    q: p.get("q") ?? "",
  };
}

// The query-string half of the URL mirror — default values are omitted so the
// pristine URL stays /ads-os/am. Returns "" or "?doer=Juan&…".
export function amFiltersQuery(f: AmFilters): string {
  const p = new URLSearchParams();
  if (f.doer !== "all") p.set("doer", f.doer);
  if (f.checker !== "all") p.set("checker", f.checker);
  if (!f.gads) p.set("gads", "0");
  if (!f.lsa) p.set("lsa", "0");
  if (f.q.trim()) p.set("q", f.q.trim());
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

// A saved filter naming someone no longer in the data must not silently hide
// every card — reset it to "all" once the payload arrives.
export function resetStalePeople(
  f: AmFilters,
  managers: string[],
  checkers: string[],
): AmFilters {
  return {
    ...f,
    doer:
      f.doer !== "all" && !managers.some((m) => firstName(m) === f.doer) ? "all" : f.doer,
    checker:
      f.checker !== "all" && !checkers.some((m) => firstName(m) === f.checker)
        ? "all"
        : f.checker,
  };
}

export const normId = (s: string) => s.replace(/[^0-9]/g, "");

// The filtered view: platform switches hide accounts; a client with no
// remaining visible accounts drops out entirely (prototype behaviour). Search
// matches client names case-insensitively and CIDs ignoring hyphens/spaces
// (digits-only compare) — "6837251501" and "683-725-1501" both match.
export function visibleAmClients(
  clients: AmClient[],
  filters: AmFilters,
): (AmClient & { accounts: AmAccount[] })[] {
  const q = filters.q.trim().toLowerCase();
  const qId = normId(q);
  return clients
    .map((c) => {
      const accounts = c.accounts.filter((a) =>
        a.product === "gads" ? filters.gads : filters.lsa,
      );
      return { ...c, accounts };
    })
    .filter((c) => {
      if (c.accounts.length === 0) return false;
      if (filters.doer !== "all" && firstName(c.doer ?? "") !== filters.doer) return false;
      if (filters.checker !== "all" && firstName(c.checker ?? "") !== filters.checker)
        return false;
      if (!q) return true;
      if (c.client.toLowerCase().includes(q)) return true;
      return qId.length > 0 && c.accounts.some((a) => normId(a.customer_id).includes(qId));
    });
}
