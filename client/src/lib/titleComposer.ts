/**
 * Pure helpers for composing the browser tab title with unread-count badges.
 *
 * Format: `(bell) (chat) Page — NoBull OS`
 *   - Bell count first, chat count second.
 *   - Zero counts are suppressed entirely (no "(0)").
 *   - Counts above 99 are capped to "99+".
 *   - When both counts are zero the title matches the existing plain format.
 */

export const TITLE_CAP = 99;
export const APP_NAME = "NoBull OS";

export function formatCountBadge(count: number): string {
  if (count <= 0) return "";
  return `(${count > TITLE_CAP ? `${TITLE_CAP}+` : count})`;
}

/**
 * Compose the final browser tab title.
 *
 * @param pageTitle  - The page-specific portion (e.g. "Clients").
 *                     Pass empty string or omit for the root page.
 * @param bellCount  - Notification-bell unread count.
 * @param chatCount  - Comms chat unread count (channels + threads).
 */
export function composeTitleWithCounts(
  pageTitle: string,
  bellCount: number,
  chatCount: number,
): string {
  const bellBadge = formatCountBadge(bellCount);
  const chatBadge = formatCountBadge(chatCount);
  const prefix = [bellBadge, chatBadge].filter(Boolean).join(" ");
  const base = pageTitle ? `${pageTitle} — ${APP_NAME}` : APP_NAME;
  return prefix ? `${prefix} ${base}` : base;
}
