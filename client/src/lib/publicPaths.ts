/**
 * Paths that are intentionally public and must never redirect to sign-in —
 * and, since Task #4225, must not fire background authenticated probes
 * (/api/auth/user, /api/notifications/unread-count) that 401 in the browser
 * console on every client-facing load.
 *
 * Single source of truth for App's AuthGate, use-auth's probe gate, and
 * GlobalTitleManager's unread-count gate. (QuicklinksBar keeps its own,
 * slightly wider, chrome-suppression list.)
 *
 * /mcu-checker stays public — sales can run capacity checks signed-out —
 * but since Task #4370 it is also an adopted internal tool: signed-in users
 * get the global nav there, and a CEO-gated quicklink points at it.
 */
export const PUBLIC_PATHS_EXACT = new Set([
  "/demo-report",
  "/access-revoked",
  // Task #4554 — closed admission: signed-in-but-unapproved Clerk sessions
  // land here. Must be public so the page never re-triggers the auth
  // probe/AuthGate loop that sent the user here in the first place.
  "/not-approved",
  "/mcu-checker",
  "/roadmap",
  "/sign-in",
  "/sign-up",
]);
export const PUBLIC_PATH_PREFIXES = [
  "/share/",
  "/preview/",
  "/book/",
  "/pulse/",
  "/apply/",
  "/roadmap/",
];

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS_EXACT.has(path)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p));
}
