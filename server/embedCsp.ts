/**
 * Task #3728 — per-path frame-ancestors relaxation for the public roadmap embed.
 *
 * The app-wide CSP pins `frame-ancestors` to 'self' + Replit preview hosts,
 * which correctly blocks third-party sites from iframing internal pages. The
 * roadmap embed exists to be iframed by arbitrary external websites, so the
 * responses for that surface — BOTH the SPA HTML document at /roadmap/embed
 * (served by vite in dev / the static catch-all in prod) AND the public JSON
 * it fetches — must carry `frame-ancestors *` instead. Everything else keeps
 * the strict policy; the relaxation is a path predicate, never a global flip.
 *
 * server/index.ts builds two helmet instances from `buildCspDirectives` and
 * dispatches per request on `isFrameRelaxedPath(req.path)`. Kept in its own
 * module so the header behavior is unit-testable without booting the server.
 */

/** Path prefixes whose responses may be framed by any origin. */
export const FRAME_RELAXED_PATH_PREFIXES = [
  "/roadmap/embed", // the chrome-less SPA embed page (HTML document)
  "/api/public/roadmap", // the published-only JSON the embed fetches
] as const;

/**
 * True when the request path belongs to the embeddable roadmap surface.
 * Matches the prefix exactly or as a path segment ("/roadmap/embed/…"),
 * never as a bare string prefix ("/roadmap/embedded-other" does NOT match).
 */
export function isFrameRelaxedPath(path: string): boolean {
  return FRAME_RELAXED_PATH_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

/** frame-ancestors for every non-embed response (the pre-#3728 global value). */
export const STRICT_FRAME_ANCESTORS = [
  "'self'",
  "https://*.replit.dev",
  "https://*.replit.com",
  "https://*.repl.co",
];

/** frame-ancestors for the embed surface: any third-party site may iframe it. */
export const EMBED_FRAME_ANCESTORS = ["*"];

/**
 * The single source of the app's CSP directive set. `frameAncestors` is the
 * only directive that varies between the strict and embed policies — sharing
 * the rest here keeps the two helmet instances from drifting apart.
 */
export function buildCspDirectives(frameAncestors: string[]): Record<string, string[]> {
  return {
    defaultSrc: ["'self'"],
    // Clerk's browser SDK is loaded from *.clerk.accounts.dev (dev FAPI) or the
    // app's proxy path in prod. challenges.cloudflare.com powers Clerk's Turnstile
    // bot protection. Both must be in scriptSrc or Clerk silently fails to load.
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com", "https://*.clerk.accounts.dev", "https://challenges.cloudflare.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.googleapis.com", "https://*.gstatic.com", "https://api.maptiler.com", "https://*.maptiler.com", "https://*.slack-edge.com", "https://avatars.slack-edge.com", "https://*.googleusercontent.com", "https://*.replit.dev", "https://img.clerk.com"],
    connectSrc: ["'self'", "https://api.maptiler.com", "https://*.maptiler.com", "https://maps.googleapis.com", "https://*.googleapis.com", "wss:", "ws:", "https://*.clerk.accounts.dev", "https://challenges.cloudflare.com"],
    workerSrc: ["'self'", "blob:"],
    childSrc: ["'self'", "blob:"],
    frameSrc: ["'self'", "https://challenges.cloudflare.com"],
    frameAncestors,
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
  };
}
