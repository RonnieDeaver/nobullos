/**
 * Task #2820 — client-side recognition of the "status unknown" 503 contract
 * that Task #2811 gave the dedicated integration status routes
 * (`/api/semrush/status`, `/api/integrations/{front,slack,zoom}/status`,
 * `/api/stripe/status`, and Task #2807's `/api/integrations/google-ads/status`).
 *
 * When a route's credential/settings read THROWS (transient DB blip, pool
 * saturation), the server responds
 * `503 { statusUnknown: true, probeFailed: true, connected/configured: null,
 * reason }` instead of a hard "not connected". The client's default query fn
 * surfaces that as `Error("503: {\"statusUnknown\":true,...}")`. Cards parse
 * that shape via `parseIntegrationStatusUnknownError`, suppress the generic
 * "Request failed" toast, and render a neutral "checking / temporarily
 * unavailable" state — preserving the last-known connection badge when the
 * query has previously succeeded (React Query keeps `data` across a failed
 * refetch).
 *
 * A genuine confirmed-empty credential still comes back as a normal
 * 200 not-connected shape and must keep rendering as Not Connected.
 * Presentation only — nothing in this contract writes breaker state.
 *
 * Task #2831 — adding a NEW client consumer of `/api/integrations/front/status`
 * or `/api/stripe/status` (neither has one today)? You must wire this parser
 * (neutral "Checking…" state + toast suppression + refetch-while-unknown) —
 * copy the pattern from client/src/pages/admin/ZoomIntegration.tsx (reference
 * implementation; rendered contract in
 * tests/client/integration-status-unknown-neutral.test.tsx). A drift guard
 * (scripts/lint-front-stripe-status-consumers.ts, gated by its SMOKE_FILES
 * test) fails the routine test gate if a client/src file mentions either
 * route without referencing parseIntegrationStatusUnknownError.
 */

export interface IntegrationStatusUnknownPayload {
  statusUnknown: true;
  probeFailed: true;
  /** Diagnostic: the thrown read's message, as forwarded by the route. */
  reason: string;
}

/** True when a (parsed) response body is the status-unknown 503 shape. */
export function isIntegrationStatusUnknownPayload(
  body: unknown,
): body is IntegrationStatusUnknownPayload {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { statusUnknown?: unknown }).statusUnknown === true &&
    (body as { probeFailed?: unknown }).probeFailed === true
  );
}

/**
 * Parse a client-side query error into the status-unknown payload, or `null`
 * when the error is anything else (including a genuine not-connected 200,
 * which never throws). Mirrors `parseGoogleAdsDisconnectedError`
 * (shared/googleAdsDisconnect.ts): the default query fn / `apiRequest` throw
 * `Error("<status>: <body text>")`.
 */
export function parseIntegrationStatusUnknownError(
  error: unknown,
): IntegrationStatusUnknownPayload | null {
  if (!(error instanceof Error)) return null;
  const msg = error.message;
  if (!msg.startsWith("503:")) return null;
  if (!msg.includes("statusUnknown")) return null;
  try {
    const parsed = JSON.parse(msg.slice("503:".length).trim());
    if (!isIntegrationStatusUnknownPayload(parsed)) return null;
    return {
      statusUnknown: true,
      probeFailed: true,
      reason:
        typeof (parsed as { reason?: unknown }).reason === "string"
          ? (parsed as { reason: string }).reason
          : "",
    };
  } catch {
    return null;
  }
}
