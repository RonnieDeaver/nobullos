/**
 * Task #4482 (bundle budget): shouldRenderGlobalQuicklinksBar moved out of
 * QuicklinksBar.tsx so App.tsx and CommsContext can gate on it WITHOUT
 * statically importing the full nav module (which pulls the radix
 * dropdown-menu closure into the entry chunk). GlobalAppNav itself is now
 * lazy in App.tsx. Same pattern as lib/publicPaths (Task #4225).
 *
 * Routes where the global quicklinks header should NOT render. These are
 * public-facing surfaces (client share links, candidate portal, booking
 * widgets, the printable demo report, etc.) where the internal nav would leak
 * chrome to people who shouldn't see it.
 */
const GLOBAL_BAR_SKIP_PREFIXES = [
  "/share/",
  "/preview/",
  "/book/",
  "/pulse/",
  "/apply/",
  "/roadmap/", // Task #3728 — the /roadmap/embed iframe surface must be chrome-less
];

const GLOBAL_BAR_SKIP_EXACT = new Set<string>([
  "/demo-report",
  // "/mcu-checker" left this list when Task #4370 adopted the checker as an
  // internal tool: signed-in users now get the global nav there, while
  // anonymous visitors (the route stays public) render no chrome anyway
  // because GlobalAppNav/CommsShell null-guard on authentication.
  "/roadmap", // Task #3728 — public-facing roadmap page renders without internal nav
]);

export function shouldRenderGlobalQuicklinksBar(pathname: string): boolean {
  if (GLOBAL_BAR_SKIP_EXACT.has(pathname)) return false;
  return !GLOBAL_BAR_SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
