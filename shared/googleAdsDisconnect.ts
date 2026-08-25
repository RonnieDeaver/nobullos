/**
 * Task #2794 — structured "Google Ads is disconnected" contract shared by the
 * Ads Hygiene routes (server) and the /admin/ads-hygiene page (client).
 *
 * When a hygiene/audit route's underlying Google call fails because the Google
 * Ads credential is auth-dead (Task #4008 unified env-credential model: the
 * GOOGLE_ADS_* secrets are incomplete, or Google's token endpoint terminally
 * rejected the env trio and the shared mint's negative cache is armed), the
 * route responds `503 { code: "google_ads_disconnected", ... }` instead of a
 * generic 500. The client detects that code (apiRequest surfaces failures as
 * `Error("503: <json body>")`), suppresses the generic "Request failed" toast,
 * and renders one page-level credentials banner pointing at the rotation
 * runbook (GOOGLE_ADS.md). Presentation only — nothing in this contract
 * writes auth state.
 */

export const GOOGLE_ADS_DISCONNECTED_CODE = "google_ads_disconnected" as const;

export interface GoogleAdsDisconnectedPayload {
  code: typeof GOOGLE_ADS_DISCONNECTED_CODE;
  /** Operator-facing headline (also rendered by the page banner). */
  message: string;
  /** The auth-dead error message that triggered the mapping (diagnostic). */
  reason: string;
  /** Terminal-rejection detail from the shared env-trio mint's negative
   * cache (e.g. "HTTP 400: invalid_grant"), if armed. */
  lastError: string | null;
}

/**
 * Parse a client-side query/mutation error into the structured disconnect
 * payload, or `null` when the error is anything else. The client's
 * `apiRequest` / default query fn throw `Error("<status>: <body text>")`, so
 * a disconnect surfaces as `"503: {\"code\":\"google_ads_disconnected\",...}"`.
 */
export function parseGoogleAdsDisconnectedError(
  error: unknown,
): GoogleAdsDisconnectedPayload | null {
  if (!(error instanceof Error)) return null;
  const msg = error.message;
  if (!msg.startsWith("503:")) return null;
  if (!msg.includes(GOOGLE_ADS_DISCONNECTED_CODE)) return null;
  try {
    const parsed = JSON.parse(msg.slice("503:".length).trim());
    if (!parsed || parsed.code !== GOOGLE_ADS_DISCONNECTED_CODE) return null;
    return {
      code: GOOGLE_ADS_DISCONNECTED_CODE,
      message:
        typeof parsed.message === "string" && parsed.message
          ? parsed.message
          : "Google Ads credentials are missing or were rejected — rotate the GOOGLE_ADS_* secret trio and restart (see GOOGLE_ADS.md).",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      lastError:
        typeof parsed.lastError === "string" && parsed.lastError
          ? parsed.lastError
          : null,
    };
  } catch {
    return null;
  }
}
