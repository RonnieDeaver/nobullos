/**
 * Integrations routes — unified hub all-status.
 * Extracted verbatim from server/routes/integrations.ts (Task #4152 / F6
 * split; original lines 63–530, 1251–1315); sections: unified hub all-status; per-credential change history (front / zoom / slack / pandadoc / semrush).
 * Mounted by registerIntegrationRoutes in ../integrations.ts — route order is
 * preserved by the aggregator's call sequence; the only in-slice edit is
 * dynamic-import specifier depth (./ -> ../, ../ -> ../../).
 */
import type { Express } from "express";
import { storage } from "../../storage";
import { withDbAttribution } from "../../db";
import {
  getCachedIntegrationStatus,
} from "../../services/integrationStatusCache";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { requireAccountManager } from "../middleware";
import type { SystemSetting } from "@shared/schema";

export function registerIntegrationsHubRoutes(app: Express) {
    // ============================================
  // UNIFIED INTEGRATIONS HUB
  // ============================================

  app.get("/api/integrations/all-status", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      // Lazy imports up front so the cache loaders close over the modules.
      // Task #3341 — Front / Zoom / Google Ads loaders live in the shared
      // module so the boot prewarm and this route stay identical.
      const statusLoadersMod = await import("../../services/integrationStatusLoaders");
      const { getFrontAuthState, reconcileFrontAuthBreakerFromStore } = await import(
        "../../services/frontAuthBreaker"
      );
      // Task #2122 — reconcile the Zoom / SEMrush durable auth signals on
      // the same badge poll so a trip / reconnect that happened on another
      // instance (or before this process started) converges here. (Google
      // Ads left this family in Task #4008: its auth state is the shared
      // env-trio mint's in-process snapshot, surfaced via the adsOs lane.)
      const {
        reconcileSemrushAuthBreakerFromStore,
        getSemrushAuthState,
        semrushAuthBreakerActive,
      } = await import("../../services/semrushAuthBreaker");
      const slackMod = await import("../../services/slackIntegration");
      const zoomMod = await import("../../services/zoomIntegration");
      const pandadocMod = await import("../../services/pandadocIntegration");
       const ghlMod = await import("../../services/ghlIntegration");
      const stripeMod = await import("../../stripeClient");
      const semrushMod = await import("../../services/semrushApi");
      // Task #3670 — v4 API-key mode indicators for the Hub card.
      const semrushAuthModeMod = await import("../../services/semrushAuthMode");
      const semrushKeyMode = semrushAuthModeMod.isSemrushKeyMode();
      const semrushKeyModeLastSuccessAt = semrushKeyMode
        ? await semrushAuthModeMod.getSemrushKeyModeLastSuccessAt()
        : null;
      // Task #3690 — live key-rejection streak state for the Hub card
      // (persistent visual signal beyond the one Slack alert).
      const semrushKeyModeAlertMod = await import("../../services/semrushKeyModeAlert");
      const semrushKeyRejection = semrushKeyMode
        ? semrushKeyModeAlertMod.getSemrushKeyModeRejectionState()
        : null;
      const { resolveLastEditedUsers, buildLastEdited } = await import("../lastEditedHelper");
      const { getAllSyncStates } = await import("../../services/syncProgressTracker");
      const { PERF } = await import("../../perfConfig");

      // Per-integration cached probes. Each loader is what gets invoked
      // on a cold/stale cache via the background-refresh path inside
      // `getCachedIntegrationStatus`. The handler itself never awaits
      // an upstream HTTP call — it only reads from the cache.
      const FRESH_OK = 60_000;

      // Loaders return `{ connected: boolean, ...extras }` so the
      // response can render the same shape it always did, additively
      // augmented with `lastCheckedAt` (and `null` connection on cold).

      const [
        front,
        slack,
        zoom,
        pandadoc,
        stripe,
        semrush,
        twilio,
         ghl,
        unmatchedCount,
      ] = await Promise.all([
        // Task #3341: Front / Zoom / Google Ads loaders extracted to
        // services/integrationStatusLoaders.ts so the boot-time prewarm
        // fires the IDENTICAL loader into the same cache key. Outcome
        // semantics (Tasks #1861/#2100/#2417) live there now.
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").FrontStatusValue>(
          "front",
          statusLoadersMod.frontStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
        // Task #3388: Slack / PandaDoc / Stripe loaders
        // extracted to services/integrationStatusLoaders.ts so the boot
        // prewarm fires the IDENTICAL loader into the same cache key.
        // Outcome semantics (Tasks #1876/#1888) live there now.
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").SlackStatusValue>(
          "slack",
          statusLoadersMod.slackStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
        // Task #1888 — outcome-aware probe contracts for Zoom / PandaDoc /
        // Stripe / Google Ads. "preserve" outcomes keep
        // the previous value and surface `lastProbeError`; "unauthorized"
        // commits Not-Connected with a `disconnectReason`.
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").ZoomStatusValue>(
          "zoom",
          statusLoadersMod.zoomStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").PandadocStatusValue>(
          "pandadoc",
          statusLoadersMod.pandadocStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").StripeStatusValue>(
          "stripe",
          statusLoadersMod.stripeStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
        // Task #1975 — SEMrush outcome-aware probe. Shared loader so
        // /api/semrush/status hits the same cache entry and preserve
        // semantics apply uniformly across both routes.
        getCachedIntegrationStatus<{ connected: boolean; disconnectReason: string | null }>(
          "semrush",
          semrushMod.semrushCachedProbeLoader,
          { freshTtlMs: FRESH_OK },
        ),
        // Task #3406 — Twilio account-resource probe via the shared
        // loader so the boot prewarm fires the IDENTICAL loader into the
        // same cache key.
        getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").TwilioStatusValue>(
          "twilio",
          statusLoadersMod.twilioStatusLoader,
          { freshTtlMs: FRESH_OK },
        ),
         getCachedIntegrationStatus<import("../../services/integrationStatusLoaders").GhlStatusValue>(
           "ghl",
           statusLoadersMod.ghlStatusLoader,
           { freshTtlMs: FRESH_OK },
         ),
        getCachedIntegrationStatus(
          "unmatchedCount",
          async () => ({ count: await storage.countUnmatchedFrontSyncEmails().catch(() => 0) }),
          { freshTtlMs: 30_000 },
        ),
      ]);

      // Sync-state + reconcile gates are local in-memory reads, safe to
      // do on the request thread.
      const syncStates = getAllSyncStates();
      // Task #2122 — reconcile the Zoom durable gate before reading it so the
      // badge reflects a trip / reconnect from another instance or before
      // this process started (read-through cached, so the poll stays cheap).
      // Task #2830 — reconciles are read-through convergence niceties that
      // read system_settings; a transient DB blip in one must degrade to the
      // current in-memory state, never 500 the whole aggregate poll (which
      // the Hub would surface as every integration looking broken).
      await zoomMod.reconcileZoomAuthGateFromStore().catch((err: any) => {
        console.warn(
          `[Integrations] all-status: zoom auth-gate reconcile blipped (using in-memory state): ${err?.message ?? err}`,
        );
      });
      const zoomAuthGate = zoomMod.getZoomAuthGate();
      const zoomScopeGates = zoomMod.getZoomScopeGates();
      const zoomReconciliationRunning = zoomMod.isZoomReconciliationRunning();
      const zoomNextReconciliationAt = zoomMod.getNextZoomReconciliationAt();
      // Task #2254 — self-heal scheduler state so the console can show the
      // next auto-retry time (or that self-heal is parked awaiting reconnect).
      const zoomSelfHeal = zoomMod.getZoomAuthSelfHealState();

      // Settings + last-edited resolution happens inside the route's
      // DB-attribution hold window so it's visible on the trends page.
      const settingsKeys = [
        slackMod.SLACK_BOT_TOKEN_SETTING_KEY,
        pandadocMod.PANDADOC_API_KEY_SETTING_KEY,
         ghlMod.GHL_PRIVATE_TOKEN_SETTING_KEY,
        stripeMod.STRIPE_SECRET_KEY_SETTING_KEY,
        "front_access_token",
        "zoom_access_token",
      ];
      // Task #2830 — a transient DB blip in this cosmetic metadata read
      // (LastEdited badges) must degrade to "no badge this poll", never 500
      // the whole aggregate route: connection status itself comes from the
      // outcome-aware probe cache above and is still perfectly serveable.
      let credentialUserMap: {
        users: Awaited<ReturnType<typeof resolveLastEditedUsers>>;
        settings: {
          slack: SystemSetting | undefined;
          pandadoc: SystemSetting | undefined;
           ghl: SystemSetting | undefined;
          stripe: SystemSetting | undefined;
          front: SystemSetting | undefined;
          zoom: SystemSetting | undefined;
        };
        _primed: number;
      };
      try {
        credentialUserMap = await withDbAttribution(
          "route:GET /api/integrations/all-status",
          async () => {
            const settingsMap = await storage.getSystemSettings(settingsKeys);
            // We need updatedAt / updatedBy for the LastEdited badges, but
            // `getSystemSettings` returns key→value only. Pull the rows we
            // already cached one-by-one (they're cache-hits after the
            // batched read above) so the last-edited UI keeps working
            // without changing the existing badge contract.
            const [
              slackSetting,
              pandadocSetting,
               ghlSetting,
              stripeSetting,
              frontSetting,
              zoomSetting,
            ] = await Promise.all(settingsKeys.map((k) => storage.getSystemSetting(k)));
            const map = await resolveLastEditedUsers([
              slackSetting?.updatedBy,
              pandadocSetting?.updatedBy,
              stripeSetting?.updatedBy,
              frontSetting?.updatedBy,
              zoomSetting?.updatedBy,
            ]);
            return {
              users: map,
              settings: {
                slack: slackSetting,
                pandadoc: pandadocSetting,
               ghl: ghlSetting,
                stripe: stripeSetting,
                front: frontSetting,
                zoom: zoomSetting,
              },
              // Avoid an unused-binding lint on settingsMap — the batched
              // read above primes the per-key cache that the per-key
              // reads then serve from.
              _primed: Object.keys(settingsMap).length,
            };
          },
        );
      } catch (err: any) {
        console.warn(
          `[Integrations] all-status: last-edited settings read blipped (degrading badges this poll): ${err?.message ?? err}`,
        );
        credentialUserMap = {
          users: new Map(),
          settings: {
            slack: undefined,
            pandadoc: undefined,
                ghl: undefined,
            stripe: undefined,
            front: undefined,
            zoom: undefined,
          },
          _primed: 0,
        };
      }

      const settings = credentialUserMap.settings;
      const userMap = credentialUserMap.users;

      // Build per-integration payload — connection fields are `null`
      // (unknown) when the cache has no value yet. The client renders
      // "Checking…" for any integration whose `connected`/`configured`
      // is `null`.
      const frontValue = front.value;
      const slackValue = slack.value;
      const zoomValue = zoom.value;
      const pandadocValue = pandadoc.value;
      const stripeValue = stripe.value;
      const semrushValue = semrush.value;
      const twilioValue = twilio.value;
       const ghlValue = ghl.value;
      const unmatchedValue = unmatchedCount.value;
      // Task #2100 — live Front auth-dead breaker state.
      // Task #2103 — reconcile against the durable `system_settings` signal
      // first so the badge reflects a trip / reconnect that happened on
      // another instance or before this process started (read-through cached,
      // so the poll stays cheap).
      // Task #2830 — like the Zoom gate reconcile above, a transient DB blip
      // in any breaker reconcile must fall back to the current in-memory
      // breaker state, never 500 the aggregate poll.
      const warnReconcileBlip = (label: string) => (err: any) => {
        console.warn(
          `[Integrations] all-status: ${label} breaker reconcile blipped (using in-memory state): ${err?.message ?? err}`,
        );
      };
      await reconcileFrontAuthBreakerFromStore().catch(warnReconcileBlip("front"));
      // Task #2122 — same reconcile for the SEMrush durable breaker so its
      // cross-instance / post-restart suppression converges on the badge poll.
      await reconcileSemrushAuthBreakerFromStore().catch(warnReconcileBlip("semrush"));
      const frontAuthState = getFrontAuthState();
      // Task #2152 — read the Slack / Google Ads / SEMrush breaker state live
      // (in-memory) so the badge can surface *when* each integration lost its
      // connection (lastTrippedAt), *when* suppression lifts (cooldownUntil =
      // openedUntil), and how many times it has tripped (tripCount), mirroring
      // the Front detail row from Task #2121.
      const slackAuthState = slackMod.getSlackAuthState();
      const semrushAuthState = getSemrushAuthState();

      // Task #3661 — latest disconnect-forensics records + SEMrush keep-alive
      // heartbeat. Best-effort reads; a blip must never fail the poll.
      const forensicsMod = await import("../../services/integrationDisconnectForensics");
      const keepAliveMod = await import("../../services/semrushTokenKeepAliveScheduler");
      // Task #4000/#4008 — Google Ads credential lane, computed live per
      // request: env presence + this process's cached/negative-cached client
      // auth state + memoized store freshness. Never POSTs to Google.
      // Best-effort: a lane blip degrades to null (card shows "Checking…"),
      // never fails the poll.
      const [semrushForensics, semrushKeepAliveHeartbeat, googleAdsOsLane] =
        await Promise.all([
          forensicsMod.getDisconnectForensics("semrush").catch(() => null),
          keepAliveMod.getSemrushKeepAliveHeartbeat().catch(() => null),
          statusLoadersMod.buildGoogleAdsOsLaneSummary().catch((err: any) => {
            console.warn(
              `[Integrations] all-status: ads-os lane build blipped (degrading to null): ${err?.message ?? err}`,
            );
            return null;
          }),
        ]);
      // Task #4008 — env-only reads (cannot throw, no DB/network).
      const googleAdsMod = await import("../../services/googleAdsIntegration");
      const googleAdsConfigured = googleAdsMod.isGoogleAdsConfigured();
      const googleAdsLoginCustomerId =
        process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/[^0-9]/g, "") || null;

      res.json({
        front: {
          connected: frontValue ? frontValue.connected : null,
          lastSyncError: frontValue?.lastSyncError ?? null,
          lastSyncSuccess: frontValue?.lastSyncSuccess ?? null,
          syncProgress: syncStates.front,
          lastCheckedAt: front.lastCheckedAt,
          // Task #1861: surface transient probe failures so the UI can
          // render "Last check failed — retrying" without flipping the
          // Connected badge.
          lastProbeError: front.lastProbeError,
          // Task #3964 (A-003 remainder) — presence-only webhook-secret
          // readiness so the admin UI can warn when production deliveries
          // would be rejected (fail-closed, #1593). Strictly boolean/null:
          // never a value, hash, prefix, or other secret-derived material.
          webhookSecretConfigured: frontValue?.webhookSecretConfigured ?? null,
          // Task #2100: surface the *why* behind a Not-Connected badge and
          // the global auth-dead breaker so the Integrations Hub can render
          // "Front disconnected — reconnect required" with a cooldown,
          // mirroring Slack. Breaker state is read live (in-memory) rather
          // than from the status cache so it reflects the current backoff.
          disconnectReason: frontValue?.reason ?? null,
          breakerOpen: frontAuthState.breakerOpen,
          cooldownRemainingMs: frontAuthState.cooldownRemainingMs,
          // Task #2121 — surface the durable breaker signal so the badge can
          // show *when* Front lost its connection (lastTrippedAt), *when*
          // suppression lifts (cooldownUntil = openedUntil), and how many
          // times it has tripped (tripCount), not just open/closed.
          lastTrippedAt: frontAuthState.lastTrippedAt,
          cooldownUntil: frontAuthState.openedUntil,
          tripCount: frontAuthState.tripCount,
          lastEdited: { token: buildLastEdited(settings.front?.updatedAt, settings.front?.updatedBy, userMap) },
        },
        slack: {
          connected: slackValue ? slackValue.connected : null,
          team: slackValue?.team ?? null,
          syncProgress: syncStates.slack,
          lastCheckedAt: slack.lastCheckedAt,
          // Task #1876: surface the *why* behind the badge state so the
          // Integrations Hub can render "Token rejected by Slack",
          // "Breaker open — retrying", or "Last probe failed — retrying"
          // instead of a bare Not Connected. `disconnectReason` is the
          // terminal Slack auth code (set on committed unauthorized);
          // `lastProbeError` is the transient reason (set on preserve).
          disconnectReason: slackValue?.reason ?? null,
          breakerOpen: slackValue?.breakerOpen ?? false,
          cooldownRemainingMs: slackValue?.cooldownRemainingMs ?? 0,
          // Task #2152 — durable breaker signal (read live), mirroring Front.
          lastTrippedAt: slackAuthState.lastTrippedAt,
          cooldownUntil: slackAuthState.openedUntil,
          tripCount: slackAuthState.tripCount,
          lastProbeError: slack.lastProbeError,
          lastEdited: { botToken: buildLastEdited(settings.slack?.updatedAt, settings.slack?.updatedBy, userMap) },
        },
        zoom: {
          connected: zoomValue ? zoomValue.connected : null,
          syncProgress: syncStates.zoom,
          webhookIngestEnabled: PERF.ZOOM_EVENT_INGEST_ENABLED,
          reconciliationEnabled: PERF.ZOOM_RECONCILIATION_ENABLED,
          reconciliationRunning: zoomReconciliationRunning,
          nextReconciliationAt: zoomNextReconciliationAt,
          reconnectRequired: { authGate: zoomAuthGate, scopeGates: zoomScopeGates },
          lastCheckedAt: zoom.lastCheckedAt,
          // Task #1888: outcome-aware probe surfaces.
          disconnectReason: zoomValue?.disconnectReason ?? null,
          lastProbeError: zoom.lastProbeError,
          // Task #2216 — surface the auth gate as a breaker signal so the
          // dedicated Zoom console can render the shared "Disconnected at"
          // detail row (mirroring Front / Slack). The Zoom gate is sticky
          // (no cooldown expiry, no trip counter), so only `breakerOpen` +
          // `lastTrippedAt` (= gate `since`) are meaningful.
          breakerOpen: !!zoomAuthGate,
          lastTrippedAt: zoomAuthGate ? new Date(zoomAuthGate.since).toISOString() : null,
          // Task #2254 — `cooldownUntil` carries the next self-heal attempt
          // time (the gate has no cooldown of its own; the self-heal loop is
          // what auto-reconnects). `selfHealParked` is true when the loop has
          // stopped retrying because the refresh token is terminally dead and
          // an operator reconnect is required.
          cooldownUntil: zoomAuthGate ? zoomSelfHeal.nextAttemptAt : null,
          selfHealParked: zoomAuthGate ? zoomSelfHeal.parked : false,
          lastEdited: { token: buildLastEdited(settings.zoom?.updatedAt, settings.zoom?.updatedBy, userMap) },
        },
        pandadoc: {
          connected: pandadocValue ? pandadocValue.connected : null,
          lastCheckedAt: pandadoc.lastCheckedAt,
          disconnectReason: pandadocValue?.disconnectReason ?? null,
          lastProbeError: pandadoc.lastProbeError,
          lastEdited: { apiKey: buildLastEdited(settings.pandadoc?.updatedAt, settings.pandadoc?.updatedBy, userMap) },
        },
        stripe: {
          connected: stripeValue ? stripeValue.connected : null,
          lastCheckedAt: stripe.lastCheckedAt,
          disconnectReason: stripeValue?.disconnectReason ?? null,
          lastProbeError: stripe.lastProbeError,
          lastEdited: { secretKey: buildLastEdited(settings.stripe?.updatedAt, settings.stripe?.updatedBy, userMap) },
        },
        // Task #3406 — real Twilio connection badge (account-resource probe).
        twilio: {
          connected: twilioValue ? twilioValue.connected : null,
          lastCheckedAt: twilio.lastCheckedAt,
          disconnectReason: twilioValue?.disconnectReason ?? null,
          lastProbeError: twilio.lastProbeError,
        },
        ghl: {
          connected: ghlValue ? ghlValue.connected : null,
          lastCheckedAt: ghl.lastCheckedAt,
          disconnectReason: ghlValue?.disconnectReason ?? null,
          lastProbeError: ghl.lastProbeError,
          lastEdited: {
            token: buildLastEdited(
              settings.ghl?.updatedAt,
              settings.ghl?.updatedBy,
              userMap,
            ),
          },
        },
        // Task #4008 — unified single-credential model: every Google Ads
        // surface (Ads OS pulls AND Ads Hygiene / Discover Customers /
        // campaign sync) mints via the shared env-trio path, so the card's
        // whole auth picture is env presence + the shared mint's in-process
        // auth snapshot (the `adsOs` lane). No stored connection row, no
        // breaker/forensics/reconnect machinery. `connected` is null only
        // while the lane itself is unavailable (blip above) so the client
        // can render "Checking…".
        googleAds: {
          configured: googleAdsConfigured,
          connected: googleAdsOsLane
            ? googleAdsConfigured && googleAdsOsLane.health !== "token_rejected"
            : null,
          loginCustomerId: googleAdsLoginCustomerId,
          adsOs: googleAdsOsLane,
        },
        semrush: {
          connected: semrushValue ? semrushValue.connected : null,
          // Task #3670 — v4 API-key mode indicator + last successful
          // key-authenticated call. In key mode the OAuth machinery
          // (breaker/keep-alive/device flow) is dormant, and
          // `semrushAuthBreakerActive()` below is hard-gated to false, so
          // `reconnectRequired` can never fire from stale OAuth state.
          authMode: semrushKeyMode ? ("api_key" as const) : ("oauth" as const),
          keyModeLastSuccessAt: semrushKeyModeLastSuccessAt,
          // Task #3690 — null outside key mode; in key mode carries the
          // per-process rejection-streak state from semrushKeyModeAlert.
          keyRejection: semrushKeyRejection,
          lastCheckedAt: semrush.lastCheckedAt,
          disconnectReason: semrushValue?.disconnectReason ?? null,
          lastProbeError: semrush.lastProbeError,
          // Task #2152 — durable breaker signal, mirroring Front.
          breakerOpen: semrushAuthState.breakerOpen,
          cooldownRemainingMs: semrushAuthState.cooldownRemainingMs,
          lastTrippedAt: semrushAuthState.lastTrippedAt,
          cooldownUntil: semrushAuthState.openedUntil,
          tripCount: semrushAuthState.tripCount,
          // Task #2225 — specific terminal trip cause so the Hub can tell the
          // operator whether to re-authorize or re-enter a secret.
          lastTrippedCode: semrushAuthState.lastTrippedCode,
          lastSuccessAt: semrushAuthState.lastSuccessAt,
          // Task #2160 — explicit operator-facing "reconnect required"
          // indicator (mirrors Zoom's `reconnectRequired`), derived from the
          // reconciled auth-dead breaker so the Hub can render an amber badge
          // when SEMrush needs re-authorization.
          reconnectRequired: semrushAuthBreakerActive(),
          // Task #3661 — latest disconnect-forensics record + keep-alive
          // heartbeat so a silent keep-alive gap is visible to operators.
          forensics: semrushForensics,
          keepAliveHeartbeat: semrushKeepAliveHeartbeat,
        },
        unmatchedCount: unmatchedValue?.count ?? 0,
        clickup: { perUser: true },
      });
    } catch (error: any) {
      console.error("[Integrations] Status error:", error);
      // Task #2830 — the aggregate poll failing does NOT mean any
      // integration is disconnected; it means we couldn't answer right now
      // (DB blip / pool saturation). Respond with the Task #2811
      // status-unknown 503 contract so the Hub keeps last-known badges and
      // renders a neutral "temporarily unavailable" state instead of a
      // wall of Not-Connected cards + a generic error toast.
      res.status(503).json({
        statusUnknown: true,
        probeFailed: true,
        reason: error?.message ?? String(error),
      });
    }
  });

  // Task #1229 / Task #1968: per-credential change history for Zoom, Front,
  // and Slack. Surfaces recent connect/refresh/disconnect events from
  // `admin_setting_audit` so admins can see who reconnected, disconnected,
  // or (for Slack) which trigger cleared the token.
  const credentialHistoryHandler = (
    settingKey:
      | "front_access_token"
      | "zoom_access_token"
      | "slack_bot_token"
      | "pandadoc_api_key"
      | "ghl_private_integration_token"
      | "semrush_access_token",
  ) =>
    async (req: any, res: any) => {
      try {
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
        const entries = await storage.listAdminSettingAudit({ settingKey, limit });
        const { attachUserInfoToAudit } = await import("../auditAuxHelpers");
        const history = await attachUserInfoToAudit(entries);
        res.json({ history });
      } catch (err: any) {
        console.error(`[CredentialHistory] ${settingKey} fetch failed:`, err?.message);
        res.status(500).json({ error: "Failed to fetch credential history" });
      }
    };

  app.get(
    "/api/integrations/front/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("front_access_token"),
  );

  app.get(
    "/api/integrations/zoom/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("zoom_access_token"),
  );

  app.get(
    "/api/integrations/slack/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("slack_bot_token"),
  );

  // Task #1977 — same per-credential history for PandaDoc and SEMrush.
  // (Google Ads had a synthetic `google_ads_oauth` history while its
  // credential lived in the retired `google_ads_connection` table; under
  // the Task #4008 env-credential model rotation is a secrets edit, so
  // there is no in-app credential history to serve.)
  app.get(
    "/api/integrations/pandadoc/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("pandadoc_api_key"),
  );

  app.get(
    "/api/integrations/ghl/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("ghl_private_integration_token"),
  );

  app.get(
    "/api/integrations/semrush/credential-history",
    isAuthenticated,
    requireAccountManager,
    credentialHistoryHandler("semrush_access_token"),
  );

}
