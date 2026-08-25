/**
 * Task #3341 — Shared integration-status cache loaders + boot prewarm.
 *
 * The `/api/integrations/all-status` route previously defined its probe
 * loaders inline, which meant the only way an integration-status cache
 * entry could ever be warmed was an admin polling the Hub. After the
 * env-namespace fix (Task on `redisCache.ts` KEY_PREFIX), the prod
 * `nobull:prod:integration_status:*` namespace starts EMPTY on every new
 * deploy, so the first admin poll after a rolling restart painted
 * "Checking…" for up to a full probe round-trip per card — and on an
 * autoscale fleet different instances disagreed until each one's probe
 * landed.
 *
 * This module extracts the critical loaders (Front, Zoom, Google Ads —
 * SEMrush already ships a shared `semrushCachedProbeLoader`) so that:
 *
 *   1. The route and the boot prewarm invoke the IDENTICAL loader for
 *      each cache key — same outcome classification, same freshTtl
 *      behavior, no drift between the two call paths.
 *   2. `prewarmCriticalIntegrationStatuses()` can fire all four probes
 *      into the cache (memory + Redis) within seconds of process boot,
 *      so the very first admin polling the Hub sees real status.
 *
 * All loaders keep the Task #1861 outcome contract: `probe_failed`
 * → `preserve` (never fabricates Not-Connected), `connected` /
 * `unauthorized` → `commit`.
 */
import {
  getCachedIntegrationStatus,
  type ProbeOutcomeResult,
} from "./integrationStatusCache";

/** Fresh-TTL for a healthy (connected) probe result. */
export const INTEGRATION_STATUS_FRESH_OK_MS = 60_000;
/** Shorter fresh-TTL after a real disconnect so a reconnect lands fast. */
export const INTEGRATION_STATUS_FRESH_DISCONNECTED_MS = 15_000;

const FRESH_OK = INTEGRATION_STATUS_FRESH_OK_MS;
const FRESH_BAD = INTEGRATION_STATUS_FRESH_DISCONNECTED_MS;

export interface FrontStatusValue {
  connected: boolean;
  lastSyncError: string | null;
  lastSyncSuccess: string | null;
  reason: string | null;
  /**
   * Audit A-003 — admin visibility for the Front webhook fail-closed gate:
   * presence-only boolean (never the secret, a prefix, or a hash). Optional
   * so older cached values still deserialize.
   */
  webhookSecretConfigured?: boolean;
}

/**
 * Front probe loader (moved verbatim from routes/integrations.ts —
 * Tasks #1861 / #2100 / #2417 semantics preserved).
 */
export async function frontStatusLoader(): Promise<ProbeOutcomeResult<FrontStatusValue>> {
  const frontMod = await import("./frontIntegration");
  const probe = await frontMod.probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
  }));
  if (probe.outcome === "probe_failed") {
    return {
      outcome: "preserve",
      lastProbeError: probe.reason ?? "probe_failed",
    };
  }
  const connected = probe.outcome === "connected";
  let lastSyncError: string | null = null;
  let lastSyncSuccess: string | null = null;
  // Task #2417: derive sync metadata regardless of `connected` — the
  // whole point of `lastSyncError` is to show a real reason when the
  // Front connection BREAKS.
  try {
    const meta = await frontMod.getSyncMetadata();
    lastSyncError = meta.lastError;
    lastSyncSuccess = meta.lastSuccess;
  } catch {}
  const { isFrontWebhookSecretConfigured } = await import("./frontWebhookIngestion");
  return {
    outcome: "commit",
    value: {
      connected,
      lastSyncError,
      lastSyncSuccess,
      reason: connected ? null : ((probe as any).reason ?? null),
      webhookSecretConfigured: isFrontWebhookSecretConfigured(),
    },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

export interface ZoomStatusValue {
  connected: boolean;
  disconnectReason: string | null;
}

/** Zoom probe loader (moved verbatim from routes/integrations.ts — Task #1888). */
export async function zoomStatusLoader(): Promise<ProbeOutcomeResult<ZoomStatusValue>> {
  const zoomMod = await import("./zoomIntegration");
  const probe = await zoomMod.probeConnection().catch((err: any) => {
    console.error(
      "[Integrations] all-status: Zoom probeConnection threw:",
      err?.message || err,
    );
    return {
      outcome: "probe_failed" as const,
      reason: `probe_threw: ${err?.message ?? "unknown"}`,
    };
  });
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: { connected, disconnectReason: connected ? null : (probe.reason ?? null) },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

export interface SlackStatusValue {
  connected: boolean;
  team: string | null;
  reason: string | null;
  breakerOpen: boolean;
  cooldownRemainingMs: number;
}

/**
 * Slack probe loader (moved verbatim from routes/integrations.ts — Task
 * #1876 outcome semantics preserved). Only `connected` / `unauthorized`
 * commit; `probe_failed` preserves so a 5xx/429/network blip never flips
 * the badge to Not Connected.
 */
export async function slackStatusLoader(): Promise<ProbeOutcomeResult<SlackStatusValue>> {
  const slackMod = await import("./slackIntegration");
  const probe = await slackMod.probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
    breakerOpen: false,
    cooldownRemainingMs: 0,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: {
      connected,
      team: (probe as any).team ?? null,
      reason: connected ? null : (probe.reason ?? null),
      breakerOpen: !!(probe as any).breakerOpen,
      cooldownRemainingMs: (probe as any).cooldownRemainingMs ?? 0,
    },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

export interface PandadocStatusValue {
  connected: boolean;
  disconnectReason: string | null;
}

/** PandaDoc probe loader (moved verbatim from routes/integrations.ts — Task #1888). */
export async function pandadocStatusLoader(): Promise<ProbeOutcomeResult<PandadocStatusValue>> {
  const pandadocMod = await import("./pandadocIntegration");
  const probe = await pandadocMod.probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: { connected, disconnectReason: connected ? null : (probe.reason ?? null) },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

export interface StripeStatusValue {
  connected: boolean;
  disconnectReason: string | null;
}

/** Stripe probe loader (moved verbatim from routes/integrations.ts — Task #1888). */
export async function stripeStatusLoader(): Promise<ProbeOutcomeResult<StripeStatusValue>> {
  const stripeMod = await import("../stripeClient");
  const probe = await stripeMod.probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: { connected, disconnectReason: connected ? null : (probe.reason ?? null) },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

export interface TwilioStatusValue {
  connected: boolean;
  disconnectReason: string | null;
}

export interface GhlStatusValue {
  connected: boolean;
  disconnectReason: string | null;
}

/** Private-token GHL probe: auth failures commit; transport failures preserve. */
export async function ghlStatusLoader(): Promise<ProbeOutcomeResult<GhlStatusValue>> {
  const ghl = await import("./ghlIntegration");
  const probe = await ghl.probeConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw:${String(err?.message ?? "unknown").slice(0, 120)}`,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: { connected, disconnectReason: connected ? null : probe.reason },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

/**
 * Twilio probe loader (Task #3406). Cheap authenticated GET against the
 * configured Account resource via `probeTwilioConnection()` in
 * twilioService.ts. Same outcome contract as the other loaders:
 * `connected` / `unauthorized` commit, `probe_failed` preserves.
 */
export async function twilioStatusLoader(): Promise<ProbeOutcomeResult<TwilioStatusValue>> {
  const twilioMod = await import("./twilioService");
  const probe = await twilioMod.probeTwilioConnection().catch((err: any) => ({
    outcome: "probe_failed" as const,
    reason: `probe_threw: ${err?.message ?? "unknown"}`,
  }));
  if (probe.outcome === "probe_failed") {
    return { outcome: "preserve", lastProbeError: probe.reason ?? "probe_failed" };
  }
  const connected = probe.outcome === "connected";
  return {
    outcome: "commit",
    value: {
      connected,
      disconnectReason: connected ? null : ((probe as any).reason ?? null),
    },
    freshTtlMs: connected ? FRESH_OK : FRESH_BAD,
  };
}

/**
 * Cache keys prewarmed at boot. MUST match the names the route passes to
 * `getCachedIntegrationStatus` so the prewarmed entries are the exact
 * entries the route reads.
 *
 * Task #3388 extended the original four critical keys (front / zoom /
 * googleAds / semrush) with the remaining Integrations Hub badge probes
 * (slack / pandadoc / stripe) so NO badge paints
 * "Checking…" after a deploy. Task #3406 added twilio (the Hub card
 * gained a real connection badge). Google Calendar is deliberately
 * absent: Calendar status is per-user (no shared cache entry). Task
 * #4008 REMOVED googleAds: its status is now derived from env presence +
 * the shared env-trio mint's in-process auth snapshot (see
 * `buildGoogleAdsOsLaneSummary` below) — process-local memory reads that
 * must not round-trip through the shared cache, and nothing about them
 * needs a boot probe.
 */
export const PREWARM_INTEGRATIONS = [
  "front",
  "zoom",
  "semrush",
  "slack",
  "pandadoc",
  "stripe",
  "twilio",
  "ghl",
] as const;

/**
 * Boot-time pre-warm for the critical integration badges. Calls the same
 * `getCachedIntegrationStatus(name, loader)` path the route uses:
 *   - hydrates from Redis if a warm peer (or the previous deploy
 *     generation within TTL) already committed a value;
 *   - otherwise kicks the probe in the background (single-flight, worker
 *     DB pool, preserve-on-transient-failure semantics all apply).
 *
 * Fire-and-forget by design: never throws, never blocks bootstrap. The
 * probes themselves complete in the background; typical wall-clock from
 * call to committed cache entry is probe latency (~0.3–3 s per
 * integration, run in parallel).
 */
export async function prewarmCriticalIntegrationStatuses(): Promise<void> {
  const startedAt = Date.now();
  const semrushMod = await import("./semrushApi");
  const loaders: Record<(typeof PREWARM_INTEGRATIONS)[number], () => Promise<any>> = {
    front: frontStatusLoader,
    zoom: zoomStatusLoader,
    semrush: semrushMod.semrushCachedProbeLoader,
    slack: slackStatusLoader,
    pandadoc: pandadocStatusLoader,
    stripe: stripeStatusLoader,
    twilio: twilioStatusLoader,
    ghl: ghlStatusLoader,
  };
  await Promise.allSettled(
    PREWARM_INTEGRATIONS.map((name) =>
      getCachedIntegrationStatus(name, loaders[name], {
        freshTtlMs: INTEGRATION_STATUS_FRESH_OK_MS,
      }),
    ),
  );
  console.log(
    `[IntegrationStatusPrewarm] kicked ${PREWARM_INTEGRATIONS.length} probe(s) in ${Date.now() - startedAt}ms (results commit in background)`,
  );
}

// ---------------------------------------------------------------------------
// Task #4000 / #4008 — Google Ads env-credential lane summary
// ---------------------------------------------------------------------------

/**
 * THE credential lane on the hub's Google Ads card. Under the unified
 * single-credential model (Task #4008) every Google Ads surface — Ads OS
 * pulls AND the platform surfaces (Ads Hygiene, Discover Customers,
 * campaign/keyword sync) — mints access tokens via the shared env-trio path
 * in `adsOs/googleAdsClient`, so this summary IS the whole Google Ads auth
 * picture: env presence, terminal-rejection state, and data freshness.
 *
 * Built per request (not through the shared status cache): env presence and
 * the client's cached/negative-cached auth state are process-local memory
 * reads that would go stale (or cross-instance wrong) if round-tripped
 * through Redis; only the store-freshness DB read is memoized (30 s,
 * in-process). NEVER performs any network call to Google.
 */
export interface GoogleAdsOsLaneSummary {
  /** All four base secrets + GOOGLE_ADS_REFRESH_TOKEN present. */
  configured: boolean;
  refreshTokenSource: "env" | "none";
  /**
   * - healthy: live cached access token (successful mint < ~55 min ago in this process)
   * - token_rejected: 5-min terminal-rejection negative cache active
   * - unknown: configured but no cached evidence either way (cold process /
   *   no pull yet) — the freshness timestamp carries the signal then
   * - not_configured: env credential(s) missing
   */
  health: "healthy" | "token_rejected" | "unknown" | "not_configured";
  /** Terminal-rejection detail (e.g. "HTTP 400: invalid_grant") when health=token_rejected. */
  healthDetail: string | null;
  /** Latest Google-pull-derived Ads OS store write (ISO), null when none/unreadable. */
  lastDataUpdateAt: string | null;
}

let _adsOsFreshnessMemo: { at: number; value: string | null } | null = null;
/** The hub polls all-status every 5 s per viewer; memoize the freshness read. */
const ADS_OS_FRESHNESS_MEMO_MS = 30_000;
export function __resetGoogleAdsOsLaneMemoForTest(): void {
  _adsOsFreshnessMemo = null;
}

/**
 * Test seam: replace the lane build wholesale (return a canned summary or
 * throw to exercise callers' read-threw branches — Task #2807 contract in
 * the google-ads status route). Mirrors the old connection-store override
 * pattern; never set outside tests.
 */
let _laneOverrideForTest: (() => Promise<GoogleAdsOsLaneSummary>) | null = null;
export function __setGoogleAdsOsLaneOverrideForTest(
  fn: (() => Promise<GoogleAdsOsLaneSummary>) | null,
): void {
  _laneOverrideForTest = fn;
}

export async function buildGoogleAdsOsLaneSummary(): Promise<GoogleAdsOsLaneSummary> {
  if (_laneOverrideForTest) return _laneOverrideForTest();
  const [cfg, client, store] = await Promise.all([
    import("./adsOs/config"),
    import("./adsOs/googleAdsClient"),
    import("./adsOs/store"),
  ]);
  const configured = cfg.isGoogleAdsConfigured();
  const source = cfg.refreshTokenSource();
  const snap = client.getAdsOsClientAuthSnapshot();
  let lastDataUpdateAt: string | null;
  if (_adsOsFreshnessMemo && Date.now() - _adsOsFreshnessMemo.at < ADS_OS_FRESHNESS_MEMO_MS) {
    lastDataUpdateAt = _adsOsFreshnessMemo.value;
  } else {
    const latest = await store.getLatestAdsOsDataUpdate(); // best-effort, never throws
    lastDataUpdateAt = latest ? latest.toISOString() : null;
    _adsOsFreshnessMemo = { at: Date.now(), value: lastDataUpdateAt };
  }
  const health: GoogleAdsOsLaneSummary["health"] =
    !configured || source === "none"
      ? "not_configured"
      : snap.authDead
        ? "token_rejected"
        : snap.hasLiveAccessToken
          ? "healthy"
          : "unknown";
  return {
    configured,
    refreshTokenSource: source,
    health,
    healthDetail: snap.authDeadDetail,
    lastDataUpdateAt,
  };
}
