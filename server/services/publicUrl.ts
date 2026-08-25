// Task #864: single shared helper for resolving the public, Twilio-reachable
// base URL of this app. Previously the same fallback chain was duplicated
// across `server/routes/twilio.ts` (5 inline copies) and
// `server/services/twilioService.ts` (1 inline copy + the existing
// `resolveBaseUrl()`), which meant any future env-var change would have to
// touch every site and risked drift.
//
// Resolution order (most-specific first):
//   1. REPLIT_DOMAINS  — production deployment hostname(s), comma-separated.
//      The canonical Twilio-reachable URL once the app is published.
//   2. REPLIT_DEV_DOMAIN — workspace dev URL (Twilio can reach this when the
//      workspace is awake; used during development).
//   3. REPL_SLUG / REPL_OWNER — legacy `*.repl.co`. Best-effort fallback;
//      Twilio cannot always reach this in current Replit deployments.
//
// Behavior when none of the above resolve to a public hostname:
//   - In test (`NODE_ENV === "test"`) we return `https://localhost:5000` so
//     test setups that never actually dial Twilio keep working.
//   - In dev/prod, callers can choose:
//       * `getPublicBaseUrl()` (strict)  — throws, matching the old
//         `resolveBaseUrl()` contract used by the outbound voice path.
//       * `getPublicBaseUrl({ allowLocalhostFallback: true })` — returns
//         `https://localhost:5000`, matching the inline TwiML duplicates
//         that were tolerant of a missing public hostname.

import { isMarketingHost } from "../website/marketingSite";

export interface GetPublicBaseUrlOptions {
  /**
   * When true, return `https://localhost:5000` instead of throwing if no
   * public hostname is configured. Mirrors the lenient inline fallback
   * the TwiML route handlers used to use directly.
   */
  allowLocalhostFallback?: boolean;
}

const LOCALHOST_FALLBACK = "https://localhost:5000";

/**
 * Task #3740: canonical hostname of the OS itself (reports.nobullmarketing.com
 * in production), resolved from the deployment domain list REGARDLESS of the
 * order domains appear in it. Once the marketing apex/www domains are added to
 * the same deployment, "first entry of REPLIT_DOMAINS" is no longer guaranteed
 * to be the OS host — Twilio callbacks and OAuth redirect URIs must never flip
 * to nobullmarketing.com just because the domain list got reordered.
 *
 * Resolution order:
 *   1. OS_CANONICAL_HOSTNAME env override (explicit pin, always wins)
 *   2. the `reports.`-prefixed entry of REPLIT_DOMAINS
 *   3. first custom (non-Replit-platform) entry that is not a marketing host
 *   4. first entry that is not a marketing host (covers *.replit.app/dev)
 *   5. first entry
 *
 * Returns null when REPLIT_DOMAINS is empty/unset so callers keep their
 * existing "REPLIT_DOMAINS not set" error behavior.
 */
export function resolveOsCanonicalHostname(): string | null {
  const explicit = process.env.OS_CANONICAL_HOSTNAME?.trim();
  if (explicit) return explicit;

  const domains = (process.env.REPLIT_DOMAINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (domains.length === 0) return null;

  const reports = domains.find((d) => d.toLowerCase().startsWith("reports."));
  if (reports) return reports;

  const isReplitPlatformHost = (d: string) =>
    /\.replit\.app$/i.test(d) || /\.replit\.dev$/i.test(d) || /\.repl\.co$/i.test(d);
  const customNonMarketing = domains.find(
    (d) => !isMarketingHost(d) && !isReplitPlatformHost(d),
  );
  if (customNonMarketing) return customNonMarketing;

  const nonMarketing = domains.find((d) => !isMarketingHost(d));
  return nonMarketing ?? domains[0];
}

function resolvePrimaryHostname(): string | null {
  const fromCanonical = resolveOsCanonicalHostname();
  if (fromCanonical) return fromCanonical;
  if (process.env.REPLIT_DEV_DOMAIN) return process.env.REPLIT_DEV_DOMAIN;
  if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
    return `${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
  }
  return null;
}

export function getPublicBaseUrl(options: GetPublicBaseUrlOptions = {}): string {
  const primary = resolvePrimaryHostname();
  if (primary) return `https://${primary}`;
  if (process.env.NODE_ENV === "test") return LOCALHOST_FALLBACK;
  if (options.allowLocalhostFallback) return LOCALHOST_FALLBACK;
  throw new Error(
    "[publicUrl] getPublicBaseUrl: no public domain available — set REPLIT_DOMAINS or REPLIT_DEV_DOMAIN before placing Twilio voice/SMS calls (Twilio cannot reach a localhost callback URL).",
  );
}
