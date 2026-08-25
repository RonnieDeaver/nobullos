export type EditorUserShape = {
  id?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
};

const SYSTEM_TOKEN_LABELS: Record<string, string> = {
  "system:pdf-webhook": "PDF webhook",
  "system:report_create": "System (report create)",
};

export function formatEditorUser(user: EditorUserShape | null | undefined): string | null {
  if (!user) return null;
  const name = [user.firstName, user.lastName]
    .filter(Boolean)
    .map((p) => String(p).trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name && user.email) return `${name} (${user.email})`;
  if (name) return name;
  if (user.email) return user.email;
  return null;
}

function formatRawEditorToken(token: string): string {
  const userMatch = /^user:(.+)$/.exec(token);
  if (userMatch) return `Unknown user (${userMatch[1]})`;
  if (token === "unknown") return "Unknown";
  if (SYSTEM_TOKEN_LABELS[token]) return SYSTEM_TOKEN_LABELS[token];
  if (token.startsWith("system:")) {
    const label = token.slice("system:".length).replace(/[-_]/g, " ");
    return `System (${label})`;
  }
  return token;
}

export type EditorAttribution = {
  changedBy?: string | null;
  changedByName?: string | null;
  changedByEmail?: string | null;
  changedByUser?: EditorUserShape | null;
};

/**
 * Format an audit editor for display, e.g. "Jane Doe (jane@firm.com)".
 *
 * Accepts the common shapes used across admin audit surfaces:
 *  - `{ changedBy, changedByName, changedByEmail }` (admin settings audit endpoints)
 *  - `{ changedBy, changedByUser: {...} }` (MatchSettings audit feed)
 *  - Raw `user:<id>` / `system:*` tokens fall back to a readable label.
 *
 * Returns `fallback` (default "System") when no editor information is present.
 */
export function formatEditorAttribution(
  entry: EditorAttribution | null | undefined,
  fallback = "System",
): string {
  if (!entry) return fallback;
  const fromUser = formatEditorUser(entry.changedByUser ?? null);
  if (fromUser) return fromUser;
  const name = entry.changedByName?.trim() || null;
  const email = entry.changedByEmail?.trim() || null;
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  if (email) return email;
  const raw = entry.changedBy?.trim();
  if (raw) {
    if (/^user:/.test(raw) || /^system:/.test(raw) || raw === "unknown") {
      return formatRawEditorToken(raw);
    }
    return `Unknown user (${raw})`;
  }
  return fallback;
}
