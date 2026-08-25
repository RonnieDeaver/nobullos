/**
 * Task #2794 / reshaped by Task #4008 — map auth-dead Google Ads errors to a
 * structured 503 on the Ads Hygiene / Audit / integration routes instead of a
 * generic `500 { error }`.
 *
 * The auth-dead phrase family is thrown by `getValidAccessToken`
 * (server/services/googleAdsIntegration.ts), unified single-credential model:
 *
 *   - "Google Ads not connected — …"                (env secrets incomplete)
 *   - "Google Ads credential rejected by Google: …" (Google's token endpoint
 *     terminally rejected the env trio — invalid_grant / invalid_client /
 *     unauthorized_client; the shared mint's 5-min negative cache is armed)
 *
 * Transient failures (network blips, timeouts, Google 5xx) deliberately do
 * NOT match: they propagate as generic errors so a blip never renders as
 * "credentials dead — rotate secrets".
 *
 * PRESENTATION ONLY: this module never writes any auth state — the
 * negative-cache decision already happened (or didn't) in the shared mint.
 * The `getAdsOsClientAuthSnapshot()` read here is display-only enrichment
 * for the banner's "last error" line (strictly a memory read; never a DB
 * read or a token POST).
 */

import type { Response } from "express";
import { GOOGLE_ADS_DISCONNECTED_CODE } from "@shared/googleAdsDisconnect";
import { getAdsOsClientAuthSnapshot } from "../services/adsOs/googleAdsClient";

const GOOGLE_ADS_AUTH_DEAD_PATTERN =
  /Google Ads not connected|Google Ads credential rejected by Google/;

export function isGoogleAdsAuthDeadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return GOOGLE_ADS_AUTH_DEAD_PATTERN.test(error.message);
}

/**
 * Task #2797 — `runGoogleAdsSync` never THROWS on a dead credential; it
 * returns `{ skipped: true, reason }` instead (so the background scheduler
 * can skip a tick quietly). When an OPERATOR triggers sync-now, the
 * credential-level skip reasons must render the same rotate-secrets message,
 * so map them back onto the auth-dead phrase family the classifier
 * recognizes. In the unified env-credential model BOTH credential reasons
 * are fixed the same way (set/rotate the GOOGLE_ADS_* secrets), so both are
 * mapped; the remaining skip reasons (overlap, kill switches) keep the plain
 * summary — editing secrets would not change them.
 */
export function googleAdsSyncSkipAuthDeadError(
  reason: string | undefined,
): Error | null {
  if (reason === "not_configured") {
    return new Error(
      "Google Ads not connected — the GOOGLE_ADS_* env secrets are incomplete (see GOOGLE_ADS.md)",
    );
  }
  if (reason === "env_token_rejected") {
    const snap = getAdsOsClientAuthSnapshot();
    return new Error(
      `Google Ads credential rejected by Google: ${snap.authDeadDetail ?? "terminal token-exchange failure"} — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md)`,
    );
  }
  return null;
}

/**
 * If `error` is an auth-dead Google Ads error, respond with the structured
 * 503 payload and return true; otherwise return false so the caller falls
 * through to its existing generic handler.
 */
export function respondGoogleAdsDisconnected(
  res: Response,
  error: unknown,
): boolean {
  if (!isGoogleAdsAuthDeadError(error)) return false;
  // Display-only enrichment: the shared mint's negative-cache detail (e.g.
  // "HTTP 400: invalid_grant"). Memory read — cannot throw, cannot mint.
  const snap = getAdsOsClientAuthSnapshot();
  res.status(503).json({
    code: GOOGLE_ADS_DISCONNECTED_CODE,
    message:
      "Google Ads credentials are missing or were rejected — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md).",
    reason: error instanceof Error ? error.message : String(error),
    lastError: snap.authDeadDetail,
  });
  return true;
}
