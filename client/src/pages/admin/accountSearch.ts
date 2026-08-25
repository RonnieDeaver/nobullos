// Account-picker search helpers shared by the Google Ads admin pages
// (currently /admin/ads-hygiene). Formerly lived in the legacy Ads OS
// frontend lib (retired in Task #3603); kept here because the hygiene
// page's account combobox still uses them.

/** 1234567890 → 123-456-7890 (Google Ads CID display format). */
export function formatId(id: string): string {
  return id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

/** Case-insensitive account search by name, city, or CID digits. */
export function matchAccounts<T extends { customerId: string; name: string; city?: string | null }>(
  accounts: T[],
  query: string,
): T[] {
  const s = query.trim().toLowerCase();
  if (!s) return accounts;
  const digits = s.replace(/\D/g, "");
  return accounts.filter(
    (a) =>
      a.name.toLowerCase().includes(s) ||
      (a.city ?? "").toLowerCase().includes(s) ||
      (digits.length > 0 && a.customerId.includes(digits)),
  );
}
