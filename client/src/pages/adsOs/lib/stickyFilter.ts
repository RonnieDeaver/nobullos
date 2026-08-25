import { useState } from "react";

// Module-level, in-memory store for dashboard filter selections (doer / checker).
// Mirrors dashCache: it survives component unmount/remount across SPA navigation —
// so filtering the Main Dashboard, opening a client profile, and coming back keeps
// the filter — but it lives only for the app session, so a full page reload starts
// fresh. Deliberately NOT sessionStorage/localStorage: a reload is the user's
// "clear it" signal, and those would survive a reload.
// Verbatim port of the bundle's frontend/src/stickyFilter.ts.
const store = new Map<string, string>();

// Like useState<string> but seeded from (and written through to) the module store
// under `key`. Empty string clears the key so an "All …" selection isn't remembered.
export function useStickyFilter(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState<string>(() => store.get(key) ?? "");
  const set = (next: string) => {
    if (next) store.set(key, next);
    else store.delete(key);
    setValue(next);
  };
  return [value, set];
}
