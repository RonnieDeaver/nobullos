import type { ClientRef, MonitoredAccount } from "./types";

// Shared account filter used by both the breadcrumb account switcher and the
// ⌘K command palette, so the two don't drift. Matches on descriptive name, the
// LSA city (so "madison" finds the right same-named location), or, if the query
// has digits, on the customer id.
export function matchAccounts<T extends MonitoredAccount>(accounts: T[], query: string): T[] {
  const s = query.trim().toLowerCase();
  if (!s) return accounts;
  const digits = s.replace(/\D/g, "");
  return accounts.filter(
    (a) =>
      a.descriptive_name.toLowerCase().includes(s) ||
      (a.city ?? "").toLowerCase().includes(s) ||
      (digits.length > 0 && a.customer_id.includes(digits))
  );
}

// Client filter for the profile switcher + ⌘K palette — matches on client name.
export function matchClients(clients: ClientRef[], query: string): ClientRef[] {
  const s = query.trim().toLowerCase();
  if (!s) return clients;
  return clients.filter((c) => c.name.toLowerCase().includes(s));
}
