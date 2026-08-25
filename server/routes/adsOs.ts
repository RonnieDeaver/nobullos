/**
 * Ads OS — API routes.
 *
 * Namespace: /api/ads-os/*  (avoids collision with existing /api/dashboard etc.)
 * Authorization (Task #4977, owner-approved): read-only GET endpoints are open
 * to any authenticated staff role (requireAccountManager = role >= account_manager,
 * i.e. every seeded role) so the whole team can VIEW Ads OS. The two client
 * criteria aliases are the owner-approved exception: their GET and PUT routes
 * require a signed-in user but no minimum role. All other mutating / trigger
 * endpoints (POST/PUT) and the diagnostics lane (/proofs/*, /status, /health,
 * /accounts/:cid/probe) remain requireCeo. GETs that accept ?force=
 * cache-busting (dashboards, pacing) intentionally stay open: a forced rebuild
 * only refreshes vendor-derived caches and mutates no stored operator state.
 *
 * Phase 0 (integration proofs):
 *   GET /api/ads-os/proofs/accounts  — MCC account list from Google Ads
 *   GET /api/ads-os/proofs/clickup   — ClickUp Client List parsed into client blocks
 *   GET /api/ads-os/proofs/openai    — OpenAI structured-output round-trip
 *   GET /api/ads-os/proofs/store     — Store put/get round-trip
 *   GET /api/ads-os/status           — Config-presence summary (no secret values)
 *
 * Phase 1 (directory, enrollment & dashboards — spec §8 paths under /api/ads-os/):
 *   GET /api/ads-os/dashboard                — GAds dashboard (force/window/compare)
 *   GET /api/ads-os/lsa/dashboard            — LSA dashboard
 *   GET /api/ads-os/combined/dashboard       — Main (per-client) dashboard
 *   GET /api/ads-os/accounts                 — all MCC accounts (raw list)
 *   GET /api/ads-os/monitored-accounts       — monitored GAds accounts (id/name/currency)
 *   GET /api/ads-os/lsa/monitored-accounts   — monitored LSA accounts (+city)
 *   GET /api/ads-os/clients                  — client list from ClickUp (no Ads API)
 *
 * Phase 2 (criteria & budget pacing — spec §6.7, §6.11, §10):
 *   GET  /api/ads-os/budget-pacing/:cid      — GAds pacing report (+force)
 *   GET  /api/ads-os/lsa/pacing/:cid         — LSA pacing report (+force)
 *   GET|PUT /api/ads-os/clients/:cid/criteria — central client criteria
 *            (+ legacy alias /api/ads-os/keyword-intel/:cid/criteria)
 *   POST /api/ads-os/cron/refresh-pacing     — morning refresh (X-Cron-Key gated)
 *
 * Phase 3 (hygiene audits — spec §6.5, §6.8):
 *   GET  /api/ads-os/audit/:cid                  — GAds hygiene audit (lookback_days/force)
 *   GET  /api/ads-os/audit/:cid/history          — stored score trail (read-only, ?limit≤12)
 *   GET  /api/ads-os/lsa/hygiene/:cid/history    — LSA score trail (read-only, ?limit≤12)
 *   GET  /api/ads-os/audit/:cid/report.html      — standalone HTML export (+download)
 *   POST /api/ads-os/dashboard/run-audits        — batch-run stale GAds audits
 *   GET  /api/ads-os/lsa/hygiene/:cid            — LSA hygiene report (lookback_days/force)
 *   GET  /api/ads-os/lsa/hygiene/:cid/report.html — standalone HTML export (+download)
 *   POST /api/ads-os/lsa/dashboard/run-audits    — batch-run stale LSA audits
 *
 * Phase 4 (Search Term Analyzer — spec §6.6):
 *   GET  /api/ads-os/keyword-intel/:cid                    — AI negative-keyword review (lookback_days/force)
 *   GET  /api/ads-os/keyword-intel/:cid/keywords           — rules-based new-keyword finder (lookback_days/force)
 *   POST /api/ads-os/keyword-intel/:cid/keywords/actioned  — mark a keyword suggestion added ({search_term, undo})
 *
 * Phase 6 (client profile, alerts & polish — spec §6.4, §6.10, §3.4, §5):
 *   GET  /api/ads-os/client/profile            — assembled per-client page (name, window, compare)
 *   GET  /api/ads-os/client/performance        — daily per-account series for the charts (name, start, end)
 *   GET  /api/ads-os/client/log-summary        — AI summary of the client-log sheet (name, force)
 *   GET  /api/ads-os/clients/:cid/sibling      — same client's other-product account ({} when none)
 *   POST /api/ads-os/dashboard/run-alerts      — recompute GAds alerts now (badges; no digest)
 *   POST /api/ads-os/lsa/dashboard/run-alerts  — recompute LSA alerts now (badges; no digest)
 *   GET  /api/ads-os/clickup/enabled           — whether ticket creation is configured
 *   POST /api/ads-os/clickup/task              — raise (or return the open) ticket for one alert
 *   GET  /api/ads-os/health                    — liveness + Ads-credentials presence
 *   GET  /api/ads-os/accounts/:cid/probe       — end-to-end proof: one trivial GAQL query
 *
 * AM Dashboard (Task #3988 — launch cards + Paused/Off verification):
 *   GET  /api/ads-os/am/dashboard              — launch cards payload (directory + store reads only)
 *   POST /api/ads-os/am/dashboard/refresh      — status verification + alert sweep (no digest)
 *
 * Individual dashboard status verification (Task #4879):
 *   POST /api/ads-os/dashboard/run-status-checks     — re-run Paused/Off check for GAds accounts
 *   POST /api/ads-os/lsa/dashboard/run-status-checks — re-run Paused/Off check for LSA accounts
 *
 * Error contract (bundle main.py): creds missing → 503, quota → 503 ("quota"),
 * Ads API error → 502, all with {detail}. Route deadlines guard against a hung
 * upstream: dashboards 120s, lists 60s → 504.
 */

import type { Express, Request, Response } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireCeo, requireAccountManager } from "./middleware";
import {
  listMccAccounts,
  adsOsGaqlSearch,
  AdsOsCredsMissing,
  AdsOsApiError,
} from "../services/adsOs/googleAdsClient";
import {
  getClientDirectory,
  clientBlocks,
  clientRecord,
  lsaCityFor,
  bundleIsLive,
  bundleAgeMs,
  bundleStaleSince,
  directoryHealth,
  normClientName,
} from "../services/adsOs/clickUpDirectory";
import { monitoredAccounts, mccEnabledAccounts } from "../services/adsOs/enrollment";
import { buildAmDashboard } from "../services/adsOs/amDashboard";
import { runStatusChecks } from "../services/adsOs/statusCheck";
import { buildDashboardCached } from "../services/adsOs/dashboardService";
import { buildLsaDashboardCached } from "../services/adsOs/lsaDashboardService";
import { buildCombinedDashboardCached } from "../services/adsOs/combinedDashboardService";
import { normalizeRange, plainToday, addDays, isoDate } from "../services/adsOs/dateRange";
import { buildClientProfile, findSibling } from "../services/adsOs/clientProfile";
import { buildClientPerformanceCached, MAX_SPAN_DAYS } from "../services/adsOs/clientPerformance";
import { getLogSummary } from "../services/adsOs/clientLog";
import { runAlerts } from "../services/adsOs/alertsEngine";
import {
  createTaskForAlert,
  AlertNotFoundError,
  ClickUpError,
} from "../services/adsOs/clickUpTasks";
import {
  runBudgetPacingCached,
  invalidatePacing,
  refreshAccountPacing,
  refreshAllPacing,
  pacingDocStatus,
} from "../services/adsOs/pacingEngine";
import { getAdsOsStoreHealth } from "../services/adsOs/storeSchema";
import {
  runLsaPacingCached,
  refreshAllLsaPacing,
  invalidateLsaPacing,
  refreshAccountLsaPacing,
} from "../services/adsOs/lsaPacingEngine";
import { runAuditCached } from "../services/adsOs/audit/engine";
import { runLsaHygieneCached } from "../services/adsOs/lsaHygieneEngine";
import { runKeywordIntelCached, invalidateKeywordIntel } from "../services/adsOs/keywordIntel/engine";
import { invalidatePyramid, runPyramidCached } from "../services/adsOs/pyramid/engine";
import { runKeywordFinderCached, normTerm } from "../services/adsOs/keywordIntel/keywordFinder";
import { setActioned } from "../services/adsOs/keywordIntel/kiStore";
import { runStaleAudits, runStaleLsaAudits } from "../services/adsOs/staleAudits";
import { renderReportHtml, safeFileName } from "../services/adsOs/reportHtml";
import {
  CriteriaRequestError,
  loadCriteria,
  saveCriteriaWithPracticeAreaSync,
  toCriteria,
  deriveDefaults,
  fetchGeoLocationNames,
} from "../services/adsOs/criteriaService";
import { adsOsStructuredCall, AdsOsOpenAiNotConfigured, AdsOsOpenAiError } from "../services/adsOs/openAiHelper";
import { postSlackText } from "../services/adsOs/slackWebhook";
import {
  clientsCriteriaStore,
  budgetPacingStore,
  getAuditScoreHistory,
  getLsaAuditScoreHistory,
  SCORE_HISTORY_MAX,
} from "../services/adsOs/store";
import {
  isClickUpConfiguredAsync,
  isOpenAiConfigured,
  isSlackConfigured,
  getCronSecret,
  getDeveloperToken,
  getLoginCustomerId,
  getClientId,
  refreshTokenSource,
  isGoogleAdsConfigured,
} from "../services/adsOs/config";
import { z } from "zod";
import {
  getCutoverState,
  putCutoverState,
  buildPreview,
  CUTOVER_MODES,
  type CutoverStateAction,
} from "../services/adsOs/paidSearchRoleCutover";

function invalidateCriteriaDependentCaches(cid: string): void {
  invalidatePacing(cid);
  invalidateLsaPacing(cid);
  invalidateKeywordIntel(cid);
  invalidatePyramid(cid);
}

export function registerAdsOsRoutes(app: Express): void {

  // ── Config status (no secret values) ──────────────────────────────────────
  // Stays CEO-only (Task #4977): integration-diagnostics surface consumed only
  // by the CEO-only System Checks tab, alongside /proofs/*.

  app.get("/api/ads-os/status", isAuthenticated, requireCeo, (_req, res) => {
    // Env-only auth (spec §9): report whether GOOGLE_ADS_REFRESH_TOKEN is set.
    // We never surface the token value.
    const tokenSource = refreshTokenSource();
    const hasRefreshToken = tokenSource === "env";
    res.json({
      googleAds: {
        // fully configured = all five credentials are resolvable
        configured:
          !!getDeveloperToken() && !!getLoginCustomerId() && !!getClientId() &&
          !!process.env.GOOGLE_ADS_CLIENT_SECRET && hasRefreshToken,
        hasDeveloperToken: !!getDeveloperToken(),
        hasLoginCustomerId: !!getLoginCustomerId(),
        hasClientId: !!getClientId(),
        // reports effective availability (connection row OR env fallback)
        hasRefreshToken,
        refreshTokenSource: tokenSource,
      },
      // Task #3655: full directory health — configured, live, bundleAgeMs,
      // last success time and the persisted last-error detail (HTTP status /
      // error class / list), so a directory outage is never just "unreachable".
      clickUp: directoryHealth(),
      openAi: { configured: isOpenAiConfigured() },
      slack: { configured: isSlackConfigured() },
      cron: { configured: !!getCronSecret() },
      // Task #3706: jsonb document-store health (pacing/hygiene/criteria/…).
      // When the tables are missing or access keeps failing, the dashboards'
      // pacing columns go blank — this block says so loudly instead of
      // leaving operators to guess from "—" cells.
      store: getAdsOsStoreHealth(),
    });
  });

  // ── Proof 1: Google Ads MCC account list ──────────────────────────────────

  app.get("/api/ads-os/proofs/accounts", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const accounts = await listMccAccounts();
      res.json({
        ok: true,
        count: accounts.length,
        accounts,
      });
    } catch (err: any) {
      if (err instanceof AdsOsCredsMissing) {
        return res.status(503).json({ ok: false, error: err.message });
      }
      if (err instanceof AdsOsApiError) {
        if (err.kind === "quota_exceeded") {
          return res.status(503).json({ ok: false, error: `quota: ${err.message}` });
        }
        return res.status(502).json({ ok: false, error: err.message });
      }
      console.error("[AdsOs/proof/accounts]", err?.message ?? err);
      return res.status(502).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // ── Proof 2: ClickUp Client List ──────────────────────────────────────────

  app.get("/api/ads-os/proofs/clickup", isAuthenticated, requireCeo, async (_req, res) => {
    if (!(await isClickUpConfiguredAsync())) {
      return res.status(503).json({ ok: false, error: "No ClickUp company token is configured (env or admin override — set one in Integrations Hub → ClickUp)." });
    }
    try {
      const bundle = await getClientDirectory({ force: true, throwOnError: true });
      res.json({
        ok: true,
        count: bundle.blocks.length,
        fetchedAt: bundle.fetchedAt,
        blocks: bundle.blocks.map((b) => {
          const rec = bundle.clients[normClientName(b.name)];
          const cids = [...b.gads_cids, ...b.lsa_cids];
          return {
            name: b.name,
            doer: rec?.doer ?? null,
            checker: rec?.checker ?? null,
            gadsCidCount: b.gads_cids.length,
            lsaCidCount: b.lsa_cids.length,
            gadsCids: b.gads_cids,
            lsaCids: b.lsa_cids,
            statuses: Object.fromEntries(cids.map((cid) => [cid, bundle.statuses[cid] ?? {}])),
            budgets: Object.fromEntries(cids.map((cid) => [cid, bundle.budgets[cid] ?? {}])),
          };
        }),
      });
    } catch (err: any) {
      console.error("[AdsOs/proof/clickup]", err?.message ?? err);
      return res.status(502).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // ── Proof 3: OpenAI structured-output round-trip ──────────────────────────

  const PROOF_REPLY_SCHEMA = {
    type: "object",
    properties: {
      greeting: { type: "string", description: "A short friendly greeting" },
      model_name: { type: "string", description: "The name of the AI model responding" },
      timestamp_utc: { type: "string", description: "Current UTC timestamp in ISO 8601 format" },
    },
    required: ["greeting", "model_name", "timestamp_utc"],
    additionalProperties: false,
  };

  app.get("/api/ads-os/proofs/openai", isAuthenticated, requireCeo, async (_req, res) => {
    if (!isOpenAiConfigured()) {
      return res.status(503).json({ ok: false, error: "OpenAI API key is not configured." });
    }
    try {
      const result = await adsOsStructuredCall(
        PROOF_REPLY_SCHEMA,
        "ads_os_proof_reply",
        [
          {
            role: "system",
            content: "You are the Ads OS integration health checker. Respond with structured JSON only.",
          },
          {
            role: "user",
            content:
              "This is a Phase 0 integration proof. Respond with: a greeting confirming you are reachable, " +
              "your model name, and the current UTC timestamp.",
          },
        ],
      );
      res.json({ ok: true, result });
    } catch (err: any) {
      if (err instanceof AdsOsOpenAiNotConfigured) {
        return res.status(503).json({ ok: false, error: err.message });
      }
      if (err instanceof AdsOsOpenAiError) {
        return res.status(502).json({ ok: false, error: err.message });
      }
      console.error("[AdsOs/proof/openai]", err?.message ?? err);
      return res.status(502).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // ── Proof 4: Store put/get round-trip ─────────────────────────────────────

  app.get("/api/ads-os/proofs/store", isAuthenticated, requireCeo, async (_req, res) => {
    const testKey = "proof-roundtrip";
    const testData = {
      phase: 0,
      description: "Ads OS Phase 0 store proof",
      written_at: new Date().toISOString(),
      random_nonce: Math.random().toString(36).slice(2),
    };
    try {
      await clientsCriteriaStore.put(testKey, testData);
      const retrieved = await clientsCriteriaStore.get(testKey);
      if (!retrieved) {
        return res.status(502).json({ ok: false, error: "Store put succeeded but get returned null." });
      }
      const matches =
        retrieved.phase === testData.phase &&
        retrieved.random_nonce === testData.random_nonce;
      res.json({
        ok: matches,
        written: testData,
        retrieved,
        roundtripOk: matches,
      });
    } catch (err: any) {
      console.error("[AdsOs/proof/store]", err?.message ?? err);
      return res.status(502).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // ── Phase 1: dashboards + account lists ───────────────────────────────────

  class DeadlineError extends Error {
    constructor(what: string, ms: number) {
      super(`${what} timed out after ${Math.round(ms / 1000)}s. Try again — a fresh build may still be warming the cache.`);
      this.name = "DeadlineError";
    }
  }

  /** Race a build against a route deadline so a hung upstream never pins the
   *  request forever (the single-flight build itself continues and lands in
   *  the cache for the retry). */
  function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError(what, ms)), ms);
        timer.unref?.();
      }),
    ]);
  }

  const DASHBOARD_DEADLINE_MS = 120_000;
  const LIST_DEADLINE_MS = 60_000;

  /** Bundle main.py error contract: creds → 503, quota → 503, Ads → 502,
   *  deadline → 504, unexpected → 500. Always {detail}. */
  function sendAdsOsError(res: Response, err: any, logTag: string): void {
    if (err instanceof AdsOsCredsMissing) {
      res.status(503).json({ detail: err.message });
      return;
    }
    if (err instanceof AdsOsApiError) {
      if (err.kind === "quota_exceeded") {
        res.status(503).json({ detail: err.message });
        return;
      }
      res.status(502).json({ detail: err.message });
      return;
    }
    if (err instanceof DeadlineError) {
      res.status(504).json({ detail: err.message });
      return;
    }
    // Analyzer (spec §6.6): AI is the feature, so OpenAI-not-configured is a
    // hard 503 (matching the bundle), and an OpenAI API failure maps like an
    // upstream error (502). Engines that merely degrade never throw these.
    if (err instanceof AdsOsOpenAiNotConfigured) {
      res.status(503).json({ detail: err.message });
      return;
    }
    if (err instanceof AdsOsOpenAiError) {
      res.status(502).json({ detail: err.message });
      return;
    }
    console.error(`[AdsOs/${logTag}]`, err?.message ?? err);
    res.status(500).json({ detail: String(err?.message ?? err) });
  }

  function dashParams(req: Request): { force: boolean; window: unknown; compare: unknown } {
    return {
      force: String(req.query.force ?? "") === "true" || String(req.query.force ?? "") === "1",
      window: req.query.window ?? 30,
      compare: req.query.compare ?? "previous",
    };
  }

  // GAds dashboard: one row per monitored account (spend/conv/CPA vs baseline).
  app.get("/api/ads-os/dashboard", isAuthenticated, requireAccountManager, async (req, res) => {
    const { force, window, compare } = dashParams(req);
    try {
      const { resp, fromCache } = await withDeadline(
        buildDashboardCached(force, window, compare),
        DASHBOARD_DEADLINE_MS,
        "GAds dashboard build",
      );
      const [win, cmp] = normalizeRange(window, compare);
      const store = getAdsOsStoreHealth();
      res.json({ ...resp, from_cache: fromCache, window: win, compare: cmp, clickup_live: bundleIsLive(), clickup_stale_since: bundleStaleSince(), clickup_bundle_age_ms: bundleAgeMs(), clickup_reason: directoryHealth().reason, store_ok: store.ok, store_reason: store.reason });
    } catch (err: any) {
      sendAdsOsError(res, err, "dashboard");
    }
  });

  // LSA dashboard: one row per monitored LSA account (cost/leads/CPL/answer rate).
  app.get("/api/ads-os/lsa/dashboard", isAuthenticated, requireAccountManager, async (req, res) => {
    const { force, window, compare } = dashParams(req);
    try {
      const { resp, fromCache } = await withDeadline(
        buildLsaDashboardCached(force, window, compare),
        DASHBOARD_DEADLINE_MS,
        "LSA dashboard build",
      );
      const [win, cmp] = normalizeRange(window, compare);
      const store = getAdsOsStoreHealth();
      res.json({ ...resp, from_cache: fromCache, window: win, compare: cmp, clickup_live: bundleIsLive(), clickup_stale_since: bundleStaleSince(), clickup_bundle_age_ms: bundleAgeMs(), clickup_reason: directoryHealth().reason, store_ok: store.ok, store_reason: store.reason });
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/dashboard");
    }
  });

  // Main dashboard: one row per client, GAds + LSA accounts merged.
  app.get("/api/ads-os/combined/dashboard", isAuthenticated, requireAccountManager, async (req, res) => {
    const { force, window, compare } = dashParams(req);
    try {
      const { resp, fromCache } = await withDeadline(
        buildCombinedDashboardCached(force, window, compare),
        DASHBOARD_DEADLINE_MS,
        "Main dashboard build",
      );
      const [win, cmp] = normalizeRange(window, compare);
      // Task #3648: the outage banner must also show when the SERVED build was
      // fallback-grouped per account (clickup_grouped=false) — even if ClickUp
      // has since recovered — so a per-account view is never silently wrong.
      // Undefined (pre-field cached payload) counts as grouped.
      const grouped = resp.clickup_grouped !== false;
      const store = getAdsOsStoreHealth();
      res.json({ ...resp, from_cache: fromCache, window: win, compare: cmp, clickup_live: bundleIsLive() && grouped, clickup_stale_since: bundleStaleSince(), clickup_bundle_age_ms: bundleAgeMs(), clickup_reason: directoryHealth().reason, store_ok: store.ok, store_reason: store.reason });
    } catch (err: any) {
      sendAdsOsError(res, err, "combined/dashboard");
    }
  });

  // All MCC accounts (raw list, incl. no-monitoring ones) — spec §8 /api/accounts.
  app.get("/api/ads-os/accounts", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const items = await withDeadline(listMccAccounts(), LIST_DEADLINE_MS, "Account list");
      res.json({
        accounts: items.map((a) => ({
          customer_id: a.customerId,
          descriptive_name: a.descriptiveName,
          currency_code: a.currencyCode,
          time_zone: a.timeZone,
          is_manager: a.isManager,
          is_test_account: a.isTestAccount,
          status: a.status,
          level: a.level,
        })),
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "accounts");
    }
  });

  // Monitored GAds accounts (id/name/currency) — header switcher / deep links.
  app.get("/api/ads-os/monitored-accounts", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const accts = await withDeadline(monitoredAccounts("gads"), LIST_DEADLINE_MS, "Monitored-account list");
      res.json({
        accounts: accts.map((a) => ({
          customer_id: a.cid,
          descriptive_name: a.name,
          currency_code: a.currency,
        })),
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "monitored-accounts");
    }
  });

  // Monitored LSA accounts (+city from the ClickUp directory).
  app.get("/api/ads-os/lsa/monitored-accounts", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const accts = await withDeadline(monitoredAccounts("lsa"), LIST_DEADLINE_MS, "LSA monitored-account list");
      res.json({
        accounts: await Promise.all(
          accts.map(async (a) => ({
            customer_id: a.cid,
            descriptive_name: a.name,
            currency_code: a.currency,
            city: await lsaCityFor(a.cid),
          })),
        ),
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/monitored-accounts");
    }
  });

  // Client list (name + products) from the ClickUp directory only — no Ads API.
  app.get("/api/ads-os/clients", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const blocks = await withDeadline(clientBlocks(), LIST_DEADLINE_MS, "Client list");
      const out = blocks
        .filter((b) => b.name && (b.gads_cids.length || b.lsa_cids.length))
        .map((b) => ({
          name: b.name,
          has_gads: b.gads_cids.length > 0,
          has_lsa: b.lsa_cids.length > 0,
        }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      res.json({ clients: out, clickup_live: bundleIsLive(), clickup_stale_since: bundleStaleSince() });
    } catch (err: any) {
      sendAdsOsError(res, err, "clients");
    }
  });

  // Per-account pacing rows read straight from the pacing store (written by the
  // morning refresh + every pacing run) — stale-while-revalidate: this endpoint
  // never calls the Ads API, so it's instant and quota-free. Status chip math
  // mirrors the shared pace-pill rules (client lib/pace.ts).
  app.get("/api/ads-os/dashboard/pacing", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      const accts = await withDeadline(monitoredAccounts("gads"), LIST_DEADLINE_MS, "Pacing account list");
      const rows = await Promise.all(
        accts.map(async (a) => {
          const pacing = ((await budgetPacingStore.get(a.cid)) ?? {}) as Record<string, any>;
          // Shared status helper (Task #3706) — adds the neutral "not_started"
          // state (budget present, pct null, doc says 0 scheduled days elapsed)
          // so an early-month weekend isn't styled like missing data.
          const status = pacingDocStatus(pacing);
          return {
            customer_id: a.cid,
            descriptive_name: a.name,
            monthly_budget: pacing.monthly_budget ?? null,
            mtd_spend: pacing.mtd_spend ?? null,
            budget_pacing_pct: pacing.budget_pacing_pct ?? null,
            expected_to_date: pacing.expected_to_date ?? null,
            recommended_daily_budget: pacing.recommended_daily_budget ?? null,
            schedule_days: Array.isArray(pacing.schedule_days) ? pacing.schedule_days : [],
            schedule_source: pacing.schedule_source ?? null,
            scheduled_days_elapsed:
              typeof pacing.scheduled_days_elapsed === "number" ? pacing.scheduled_days_elapsed : null,
            status,
            generated_at: pacing.generated_at ?? null,
          };
        }),
      );
      const stamps = rows.map((r) => r.generated_at).filter(Boolean) as string[];
      const store = getAdsOsStoreHealth();
      res.json({
        rows,
        last_refreshed: stamps.length ? stamps.sort().at(-1) : null,
        clickup_live: bundleIsLive(),
        clickup_stale_since: bundleStaleSince(),
        store_ok: store.ok,
        store_reason: store.reason,
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "dashboard/pacing");
    }
  });

  // Force-refresh the ClickUp directory bundle (Task #3609): invalidates the
  // 10-min TTL cache and re-fetches synchronously so an operator's ClickUp
  // "Ads Status" edit takes effect immediately. Proof-mode (throwOnError)
  // because the whole point is a fresh fetch — degrading to the stale bundle
  // would silently report "refreshed" without refreshing anything.
  app.post("/api/ads-os/directory/refresh", isAuthenticated, requireCeo, async (_req, res) => {
    if (!(await isClickUpConfiguredAsync())) {
      return res.status(503).json({ detail: "No ClickUp company token is configured (env or admin override — set one in Integrations Hub → ClickUp)." });
    }
    try {
      const bundle = await withDeadline(
        getClientDirectory({ force: true, throwOnError: true }),
        LIST_DEADLINE_MS,
        "Directory refresh",
      );
      res.json({
        ok: true,
        clients: bundle.blocks.length,
        fetched_at: new Date(bundle.fetchedAt).toISOString(),
      });
    } catch (err: any) {
      if (err instanceof DeadlineError) {
        return res.status(504).json({ detail: err.message });
      }
      console.error("[AdsOs/directory/refresh]", err?.message ?? err);
      return res.status(502).json({ detail: String(err?.message ?? err) });
    }
  });

  // ── Phase 2: budget pacing tools ──────────────────────────────────────────

  // GAds budget-pacing report for one account (run or serve cached; ?force=1).
  app.get("/api/ads-os/budget-pacing/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    const force = String(req.query.force ?? "") === "true" || String(req.query.force ?? "") === "1";
    try {
      const { report, fromCache } = await withDeadline(
        runBudgetPacingCached(String(req.params.cid), force),
        DASHBOARD_DEADLINE_MS,
        "Budget pacing run",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "budget-pacing");
    }
  });

  // LSA budget-pacing report for one account (run or serve cached; ?force=1).
  app.get("/api/ads-os/lsa/pacing/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    const force = String(req.query.force ?? "") === "true" || String(req.query.force ?? "") === "1";
    try {
      const { report, fromCache } = await withDeadline(
        runLsaPacingCached(String(req.params.cid), force),
        DASHBOARD_DEADLINE_MS,
        "LSA pacing run",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/pacing");
    }
  });

  // ── Phase 2: central client criteria (spec §6.11) ─────────────────────────
  // Served under the neutral /clients path; the /keyword-intel path is kept as
  // an alias so bundle-era deep links keep working.

  const getCriteriaHandler = async (req: Request, res: Response) => {
    const cid = String(req.params.cid).replace(/-/g, "").trim().replace(/[^0-9]/g, "");
    try {
      const {
        criteria,
        hasSaved,
        updatedAt,
        practiceAreaOptions,
        practiceAreaSyncAvailable,
        practiceAreaSyncReason,
      } = await loadCriteria(cid);
      let accountName = cid;
      let geoNames: string[] = [];
      try {
        const mcc = await withDeadline(mccEnabledAccounts(), LIST_DEADLINE_MS, "Account lookup");
        accountName = mcc.get(cid)?.name ?? cid;
        geoNames = await withDeadline(fetchGeoLocationNames(cid), LIST_DEADLINE_MS, "Geo lookup");
      } catch (err) {
        // Geo/name derivation is best-effort on Ads errors — still return saved
        // criteria. Creds-missing fails hard (503), mirroring the bundle.
        if (err instanceof AdsOsCredsMissing) return sendAdsOsError(res, err, "criteria:get");
        if (!(err instanceof AdsOsApiError) && !(err instanceof DeadlineError)) throw err;
      }
      res.json({
        customer_id: cid,
        account_name: accountName,
        has_saved: hasSaved,
        criteria,
        derived: deriveDefaults(accountName, geoNames),
        updated_at: updatedAt,
        practice_area_options: practiceAreaOptions,
        practice_area_sync_available: practiceAreaSyncAvailable,
        practice_area_sync_reason: practiceAreaSyncReason,
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "criteria:get");
    }
  };

  const putCriteriaHandler = async (req: Request, res: Response) => {
    const cid = String(req.params.cid).replace(/-/g, "").trim().replace(/[^0-9]/g, "");
    try {
      if (!cid) return res.status(400).json({ detail: "Invalid customer id." });
      if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
        return res.status(400).json({ detail: "Body must be a criteria object." });
      }
      if (
        "practice_areas" in req.body &&
        (!Array.isArray(req.body.practice_areas) ||
          req.body.practice_areas.some((label: unknown) => typeof label !== "string"))
      ) {
        return res.status(400).json({
          detail: "Practice areas must be an array of ClickUp option labels.",
        });
      }
      if (
        "practice_area_sync_base" in req.body &&
        (!Array.isArray(req.body.practice_area_sync_base) ||
          req.body.practice_area_sync_base.some(
            (label: unknown) => typeof label !== "string",
          ))
      ) {
        return res.status(400).json({
          detail: "Practice-area sync base must be an array of ClickUp option labels.",
        });
      }
      const body = toCriteria(req.body); // drops unknown keys, coerces field types
      const {
        before,
        criteria: saved,
        updatedAt,
      } = await saveCriteriaWithPracticeAreaSync(
        cid,
        body,
        req.body.practice_area_sync_base,
      );
      // Every criteria consumer must recompute against the same effective
      // ClickUp-authoritative practice-area selection.
      invalidateCriteriaDependentCaches(cid);
      // The GAds schedule drives the GAds pacing math — refresh the dashboard
      // store now so the column matches the tool without waiting for the next
      // run or the morning job. (Best-effort; never fails the save.)
      if (JSON.stringify(before.schedule_days) !== JSON.stringify(saved.schedule_days)) {
        await refreshAccountPacing(cid);
      }
      // Same hook for the LSA schedule → LSA dashboard pacing store.
      if (JSON.stringify(before.lsa_schedule_days) !== JSON.stringify(saved.lsa_schedule_days)) {
        await refreshAccountLsaPacing(cid);
      }
      res.json({ ok: true, updated_at: updatedAt });
    } catch (err: any) {
      if (err instanceof CriteriaRequestError) {
        if (err.criteriaAuthorityChanged) {
          // ClickUp already committed and is now the effective read authority,
          // even though the strict local mirror failed. Do not serve stale
          // criteria-dependent reports during the operator's safe retry.
          invalidateCriteriaDependentCaches(cid);
        }
        return res.status(err.status).json({ detail: err.message });
      }
      sendAdsOsError(res, err, "criteria:put");
    }
  };

  // Multi-line form: bare-reference handlers must use the multi-line
  // registration so BARE_REF_CLOSE_REGEX picks them up in the route-inventory
  // parser (lint-single-line-bare-ref-routes enforces this — Task #4995).
  app.get(
    "/api/ads-os/clients/:cid/criteria",
    isAuthenticated,
    getCriteriaHandler,
  );
  app.get(
    "/api/ads-os/keyword-intel/:cid/criteria",
    isAuthenticated,
    getCriteriaHandler,
  );
  app.put(
    "/api/ads-os/clients/:cid/criteria",
    isAuthenticated,
    putCriteriaHandler,
  );
  app.put(
    "/api/ads-os/keyword-intel/:cid/criteria",
    isAuthenticated,
    putCriteriaHandler,
  );

  // ── Phase 3: hygiene audits (spec §6.5, §6.8) ─────────────────────────────

  /** ?lookback_days=N → positive int or null (engine applies its default). */
  function lookbackParam(req: Request): number | null {
    const n = parseInt(String(req.query.lookback_days ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function boolParam(req: Request, name: string): boolean {
    const v = String(req.query[name] ?? "");
    return v === "true" || v === "1";
  }
  /** ?limit=N for the history routes → clamped to 1..SCORE_HISTORY_MAX (default max). */
  function historyLimitParam(req: Request): number {
    const n = parseInt(String(req.query.limit ?? ""), 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, SCORE_HISTORY_MAX) : SCORE_HISTORY_MAX;
  }

  // The batch sweep audits many accounts (pool of 4); each audit persists its
  // own score, so even a deadline reply leaves the finished scores in place.
  const RUN_AUDITS_DEADLINE_MS = 300_000;

  // GAds hygiene audit for one account (run or serve cached; 1h TTL).
  app.get("/api/ads-os/audit/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const [report, fromCache] = await withDeadline(
        runAuditCached(String(req.params.cid), lookbackParam(req), boolParam(req, "force")),
        DASHBOARD_DEADLINE_MS,
        "Hygiene audit run",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "audit");
    }
  });

  // Explicit run trigger: always forces a fresh audit (bypasses the 1h cache)
  // and persists the score. Equivalent to GET ?force=true, kept as a POST so
  // "run" is an explicit action verb for operators/automation.
  app.post("/api/ads-os/audit/:cid/run", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const [report] = await withDeadline(
        runAuditCached(String(req.params.cid), lookbackParam(req), true),
        DASHBOARD_DEADLINE_MS,
        "Hygiene audit run",
      );
      res.json({ ...report, from_cache: false });
    } catch (err: any) {
      sendAdsOsError(res, err, "audit/run");
    }
  });

  // Standalone, self-contained HTML export of the audit (served from cache).
  app.get("/api/ads-os/audit/:cid/report.html", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const [report] = await withDeadline(
        runAuditCached(String(req.params.cid), lookbackParam(req)),
        DASHBOARD_DEADLINE_MS,
        "Hygiene audit run",
      );
      if (boolParam(req, "download")) {
        const safe = safeFileName(report.account_name, report.customer_id);
        const date = report.generated_at.slice(0, 10);
        res.setHeader("Content-Disposition", `attachment; filename="hygiene-${safe}-${date}.html"`);
      }
      res.type("html").send(renderReportHtml(report));
    } catch (err: any) {
      sendAdsOsError(res, err, "audit/report.html");
    }
  });

  // Run hygiene audits for every monitored account whose score is missing or
  // stale (>7 days). Synchronous on purpose: the work happens inside the
  // request; the dashboard's live score-overlay reflects it on the next load.
  app.post("/api/ads-os/dashboard/run-audits", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const result = await withDeadline(runStaleAudits(), RUN_AUDITS_DEADLINE_MS, "Stale-audit sweep");
      res.json(result);
    } catch (err: any) {
      sendAdsOsError(res, err, "dashboard/run-audits");
    }
  });

  // Read-only score-history trail for the GAds audit (no re-run). Newest first.
  app.get("/api/ads-os/audit/:cid/history", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const history = await getAuditScoreHistory(String(req.params.cid), historyLimitParam(req));
      res.json({ customer_id: String(req.params.cid).replace(/[^0-9]/g, ""), history });
    } catch (err: any) {
      sendAdsOsError(res, err, "audit/history");
    }
  });

  // LSA hygiene report for one account (same shape as the GAds audit).
  app.get("/api/ads-os/lsa/hygiene/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const [report, fromCache] = await withDeadline(
        runLsaHygieneCached(String(req.params.cid), lookbackParam(req), boolParam(req, "force")),
        DASHBOARD_DEADLINE_MS,
        "LSA hygiene run",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/hygiene");
    }
  });

  // Read-only LSA score-history trail (mirrors the GAds route). Newest first.
  app.get("/api/ads-os/lsa/hygiene/:cid/history", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const history = await getLsaAuditScoreHistory(String(req.params.cid), historyLimitParam(req));
      res.json({ customer_id: String(req.params.cid).replace(/[^0-9]/g, ""), history });
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/hygiene/history");
    }
  });

  // Standalone HTML export of the LSA hygiene audit (reuses the shared renderer).
  app.get("/api/ads-os/lsa/hygiene/:cid/report.html", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const [report] = await withDeadline(
        runLsaHygieneCached(String(req.params.cid), lookbackParam(req)),
        DASHBOARD_DEADLINE_MS,
        "LSA hygiene run",
      );
      if (boolParam(req, "download")) {
        const safe = safeFileName(report.account_name, report.customer_id);
        const date = report.generated_at.slice(0, 10);
        res.setHeader("Content-Disposition", `attachment; filename="lsa-hygiene-${safe}-${date}.html"`);
      }
      res.type("html").send(renderReportHtml(report));
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/hygiene/report.html");
    }
  });

  // Run LSA hygiene for every monitored account whose score is missing or stale.
  app.post("/api/ads-os/lsa/dashboard/run-audits", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      const result = await withDeadline(runStaleLsaAudits(), RUN_AUDITS_DEADLINE_MS, "Stale LSA-audit sweep");
      res.json(result);
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/dashboard/run-audits");
    }
  });

  // ── Phase 4: Search Term Analyzer (spec §6.6) ─────────────────────────────

  // A 500-term run is ~13 OpenAI batches (4 concurrent), so the negatives mode
  // gets the long deadline; the build keeps running past a 504 and lands in the
  // cache for the retry.
  const ANALYZER_DEADLINE_MS = 300_000;

  // Negative-keyword suggestions for one account (run or serve cached; 1h TTL).
  app.get("/api/ads-os/keyword-intel/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const { report, fromCache } = await withDeadline(
        runKeywordIntelCached(String(req.params.cid), lookbackParam(req), boolParam(req, "force")),
        ANALYZER_DEADLINE_MS,
        "Search-term review",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "keyword-intel");
    }
  });

  // Rules-based new-keyword suggestions (converting terms) for one account.
  app.get("/api/ads-os/keyword-intel/:cid/keywords", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const { report, fromCache } = await withDeadline(
        runKeywordFinderCached(String(req.params.cid), lookbackParam(req), boolParam(req, "force")),
        DASHBOARD_DEADLINE_MS,
        "New-keyword scan",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "keyword-finder");
    }
  });

  // ── Phase 5: Pyramid Breakdown (spec §6.9) ────────────────────────────────
  // AI campaign performance review (7 GAQL pulls -> rules -> 2 AI stages ->
  // guards). Fixed 30-full-day window, 1h cache + single-flight; AI trouble
  // degrades inside the engine (partial / rules_only), it never throws here.
  // Same long deadline as the analyzer — stage 1 alone can be ~10 OpenAI
  // batches on a big account.
  app.get("/api/ads-os/pyramid/:cid", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const { report, fromCache } = await withDeadline(
        runPyramidCached(String(req.params.cid), boolParam(req, "force")),
        ANALYZER_DEADLINE_MS,
        "Pyramid Breakdown",
      );
      res.json({ ...report, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "pyramid");
    }
  });

  // Mark a converting-term keyword suggestion as added (or undo). Actioned
  // suggestions stop resurfacing in the New Keywords tool. (Negatives are never
  // suppressed this way — a negated term still serving is real waste.)
  app.post("/api/ads-os/keyword-intel/:cid/keywords/actioned", isAuthenticated, requireCeo, async (req, res) => {
    try {
      const cid = String(req.params.cid).replace(/-/g, "").trim();
      const body = req.body ?? {};
      const term = typeof body.search_term === "string" ? body.search_term : "";
      if (!term.trim()) return res.status(400).json({ detail: "search_term is required." });
      await setActioned(cid, normTerm(term), !body.undo);
      res.json({ ok: true });
    } catch (err: any) {
      sendAdsOsError(res, err, "keywords/actioned");
    }
  });

  // ── Phase 6: client profile, performance & log summary (spec §6.4) ───────

  // Everything the per-client page needs in one call, assembled from the
  // combined-dashboard cache + the pacing/hygiene/quality/pyramid/alerts
  // stores — zero Ads API calls on a warm cache.
  app.get("/api/ads-os/client/profile", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const name = String(req.query.name ?? "").trim();
      if (!name) return res.status(400).json({ detail: "name is required." });
      const profile = await withDeadline(
        buildClientProfile(name, req.query.window ?? 30, req.query.compare ?? "previous"),
        DASHBOARD_DEADLINE_MS,
        "Client profile",
      );
      if (!profile) {
        return res.status(404).json({ detail: `No monitored client named '${name}'` });
      }
      res.json(profile);
    } catch (err: any) {
      sendAdsOsError(res, err, "client/profile");
    }
  });

  // Raw daily per-account series for the performance charts. The browser does
  // ALL derivation (presets, bucketing) from one fetch — so the server just
  // validates the window and serves the cached build. End is clamped to
  // yesterday (today's partial day never charts); span capped at MAX_SPAN_DAYS.
  app.get("/api/ads-os/client/performance", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const name = String(req.query.name ?? "").trim();
      if (!name) return res.status(400).json({ detail: "name is required." });
      const startRaw = String(req.query.start ?? "").trim();
      const endRaw = String(req.query.end ?? "").trim();
      const isIsoDay = (s: string) =>
        /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
      if (!isIsoDay(startRaw) || !isIsoDay(endRaw)) {
        return res.status(422).json({ detail: "start and end must be YYYY-MM-DD dates." });
      }
      const yesterday = isoDate(addDays(plainToday(), -1));
      const end = endRaw < yesterday ? endRaw : yesterday;
      if (startRaw > end) {
        return res.status(422).json({ detail: "Start date must be on or before the end date (ranges end yesterday)." });
      }
      const spanDays =
        Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${startRaw}T00:00:00Z`)) / 86_400_000) + 1;
      if (spanDays > MAX_SPAN_DAYS) {
        return res.status(422).json({ detail: `Date range too long (max ${MAX_SPAN_DAYS} days).` });
      }
      const { resp, fromCache } = await withDeadline(
        buildClientPerformanceCached(name, startRaw, end),
        DASHBOARD_DEADLINE_MS,
        "Client performance",
      );
      if (!resp) {
        return res.status(404).json({ detail: `No monitored client named '${name}'` });
      }
      res.json({ ...resp, from_cache: fromCache });
    } catch (err: any) {
      sendAdsOsError(res, err, "client/performance");
    }
  });

  // AI summary of the client's "Paid Search Client Log" sheet (spec §6.4). The
  // page loads this async — it never delays the profile. Every failure mode is
  // a state code the client renders as plain English, never a hard error.
  app.get("/api/ads-os/client/log-summary", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      const name = String(req.query.name ?? "").trim();
      if (!name) return res.status(400).json({ detail: "name is required." });
      const force = String(req.query.force ?? "") === "true" || String(req.query.force ?? "") === "1";
      const rec = await clientRecord(name);
      if (!rec) {
        const blocks = await clientBlocks();
        return res.json({ state: blocks.length ? "client_not_in_directory" : "directory_unavailable" });
      }
      const summary = await withDeadline(
        getLogSummary(rec.name || name, rec.log_url, force),
        DASHBOARD_DEADLINE_MS,
        "Client log summary",
      );
      res.json(summary);
    } catch (err: any) {
      sendAdsOsError(res, err, "client/log-summary");
    }
  });

  // Same client's account in the OTHER product (for the "this client also runs
  // GAds/LSA ↗" breadcrumb pill). Best-effort by design: {} on no sibling AND
  // on any lookup hiccup — the pill just doesn't render.
  app.get("/api/ads-os/clients/:cid/sibling", isAuthenticated, requireAccountManager, async (req, res) => {
    try {
      res.json((await findSibling(String(req.params.cid ?? ""))) ?? {});
    } catch {
      res.json({});
    }
  });

  // ── Phase 6: Account Alerts + ClickUp tickets (spec §6.10) ────────────────

  // Recompute alerts for every monitored account of one product and persist
  // them (the dashboard ⚠ badges read the store). No Slack digest here — the
  // morning cron owns notifications; a manual refresh just updates badges.
  app.post("/api/ads-os/dashboard/run-alerts", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      res.json(await withDeadline(runAlerts(false, ["gads"]), DASHBOARD_DEADLINE_MS, "Alerts run"));
    } catch (err: any) {
      sendAdsOsError(res, err, "dashboard/run-alerts");
    }
  });

  app.post("/api/ads-os/lsa/dashboard/run-alerts", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      res.json(await withDeadline(runAlerts(false, ["lsa"]), DASHBOARD_DEADLINE_MS, "LSA alerts run"));
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/dashboard/run-alerts");
    }
  });

  // Combined recompute (spec §8): BOTH products, still no Slack — the morning
  // cron owns notifications. Wired to the Main Dashboard's Refresh so the
  // client-profile alert chips and per-product badges are fresh after it.
  app.post("/api/ads-os/combined/dashboard/run-alerts", isAuthenticated, requireCeo, async (_req, res) => {
    try {
      res.json(
        await withDeadline(runAlerts(false, ["gads", "lsa"]), DASHBOARD_DEADLINE_MS, "Combined alerts run"),
      );
    } catch (err: any) {
      sendAdsOsError(res, err, "combined/dashboard/run-alerts");
    }
  });

  // ── AM Dashboard (Task #3988): launch cards + Paused/Off verification ─────

  // One launch card per client (accounts + deep links + client log),
  // filterable by ads manager. Built from the cached ClickUp directory plus
  // two store reads — no Ads API calls, so it's effectively instant. Read-only.
  app.get("/api/ads-os/am/dashboard", isAuthenticated, requireAccountManager, async (_req, res) => {
    try {
      res.json(await withDeadline(buildAmDashboard(), LIST_DEADLINE_MS, "AM dashboard"));
    } catch (err: any) {
      sendAdsOsError(res, err, "am/dashboard");
    }
  });

  // Recompute the two overlays the AM Dashboard shows but does not itself
  // produce — account alerts (the card's ⚠ badge) and the Paused/Off
  // verification (the ✓/✗ on every status chip) — so both refresh on demand
  // instead of waiting for the morning cron. Same work the cron does, minus
  // the pacing sweep and the Slack digest (the cron owns that; a Refresh must
  // never page the channel).
  //
  // Status checks run FIRST and deliberately so. They cover ~a dozen accounts
  // with one query each (seconds); the alert sweep covers the whole roster
  // with several queries each (minutes). runAlerts persists per account as it
  // goes, so a timeout mid-sweep still banks most of its work — but the status
  // batch is ONE document written at the very end, so behind the alerts it
  // would be the only thing a deadline could lose completely.
  // Cheapest-and-most-fragile first.
  //
  // The two phases are isolated in BOTH directions and the route stays 200
  // when either one fails. Letting the alert sweep raise past a verification
  // that already ran and persisted would throw away a result the caller can
  // see is good — and the button would report "Refresh failed" for work that
  // succeeded. Each half reports its own outcome; the frontend says which one
  // broke.
  // GAds dashboard: re-run Paused/Off verification on demand. No alert sweep
  // here — the button's only job is to re-check the status chips. Mirrors the
  // credential gate used by the AM Dashboard refresh.
  app.post("/api/ads-os/dashboard/run-status-checks", isAuthenticated, requireCeo, async (_req, res) => {
    if (!isGoogleAdsConfigured()) {
      return sendAdsOsError(
        res,
        new AdsOsCredsMissing(
          "Google Ads credentials incomplete. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN.",
        ),
        "dashboard/run-status-checks",
      );
    }
    try {
      const result = await withDeadline(runStatusChecks(), DASHBOARD_DEADLINE_MS, "Status checks");
      res.json(result);
    } catch (err: any) {
      sendAdsOsError(res, err, "dashboard/run-status-checks");
    }
  });

  // LSA dashboard: same on-demand status check trigger (runStatusChecks covers
  // both products in one pass — the endpoint is distinct so the LSA toolbar
  // button has its own logical action and testId).
  app.post("/api/ads-os/lsa/dashboard/run-status-checks", isAuthenticated, requireCeo, async (_req, res) => {
    if (!isGoogleAdsConfigured()) {
      return sendAdsOsError(
        res,
        new AdsOsCredsMissing(
          "Google Ads credentials incomplete. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN.",
        ),
        "lsa/dashboard/run-status-checks",
      );
    }
    try {
      const result = await withDeadline(runStatusChecks(), DASHBOARD_DEADLINE_MS, "Status checks");
      res.json(result);
    } catch (err: any) {
      sendAdsOsError(res, err, "lsa/dashboard/run-status-checks");
    }
  });

  app.post("/api/ads-os/am/dashboard/refresh", isAuthenticated, requireCeo, async (_req, res) => {
    if (!isGoogleAdsConfigured()) {
      return sendAdsOsError(
        res,
        new AdsOsCredsMissing(
          "Google Ads credentials incomplete. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN.",
        ),
        "am/dashboard/refresh",
      );
    }

    const phaseError = (err: any): { error: string } => ({
      // The Ads API's own message is the useful part; anything else degrades
      // to the class name (mirrors the reference's _format_ads_error split).
      error:
        err instanceof AdsOsApiError
          ? String(err.message)
          : String(err?.constructor?.name || err?.name || "Error"),
    });

    let statusChecks: Record<string, any>;
    try {
      statusChecks = await withDeadline(runStatusChecks(), DASHBOARD_DEADLINE_MS, "Status checks");
    } catch (err: any) {
      statusChecks = phaseError(err);
    }

    let alerts: Record<string, any>;
    try {
      alerts = (await withDeadline(
        runAlerts(false, ["gads", "lsa"]),
        DASHBOARD_DEADLINE_MS,
        "Combined alerts run",
      )) as unknown as Record<string, any>;
    } catch (err: any) {
      alerts = phaseError(err);
    }

    res.json({ alerts, status_checks: statusChecks });
  });

  // Whether ClickUp ticket creation is available (token present). The client
  // hides every "Create ClickUp Task" button when false.
  app.get("/api/ads-os/clickup/enabled", isAuthenticated, requireAccountManager, async (_req, res) => {
    res.json({ enabled: await isClickUpConfiguredAsync() });
  });

  // Raise (or return the already-open) ClickUp ticket for one dashboard alert.
  // Idempotent while a ticket is open. The server re-reads the alert's
  // title/detail from the alerts store — the client only names the alert.
  app.post("/api/ads-os/clickup/task", isAuthenticated, requireCeo, async (req, res) => {
    if (!(await isClickUpConfiguredAsync())) {
      return res.status(503).json({ detail: "ClickUp is not configured" });
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const product = body.product === "lsa" ? "lsa" : body.product === "gads" ? "gads" : null;
      const cid = String(body.customer_id ?? "").replace(/-/g, "").trim();
      const code = String(body.code ?? "").trim();
      if (!product || !cid || !code) {
        return res.status(400).json({ detail: "product, customer_id and code are required." });
      }
      res.json(await createTaskForAlert(product, cid, code));
    } catch (err: any) {
      if (err instanceof AlertNotFoundError) {
        return res.status(404).json({ detail: err.message });
      }
      if (err instanceof ClickUpError) {
        return res.status(502).json({ detail: `ClickUp error: ${err.message}` });
      }
      sendAdsOsError(res, err, "clickup/task");
    }
  });

  // ── Phase 6: health + end-to-end probe ────────────────────────────────────
  // Both stay CEO-only (Task #4977): diagnostics lane, same policy as /proofs/*.

  app.get("/api/ads-os/health", isAuthenticated, requireCeo, (_req, res) => {
    res.json({
      status: "ok",
      ads_credentials_present:
        !!getDeveloperToken() && !!getLoginCustomerId() && !!getClientId() &&
        !!process.env.GOOGLE_ADS_CLIENT_SECRET && refreshTokenSource() === "env",
    });
  });

  // End-to-end proof: run one GAQL query against the selected account. Pulls
  // basic customer info + an enabled-campaign count — the "one trivial query
  // works" milestone, not an audit.
  app.get("/api/ads-os/accounts/:cid/probe", isAuthenticated, requireCeo, async (req, res) => {
    const cid = String(req.params.cid ?? "").replace(/-/g, "").trim();
    try {
      const accounts = await withDeadline(listMccAccounts(), LIST_DEADLINE_MS, "Account list");
      const acct = accounts.find((a) => a.customerId === cid) ?? null;
      const infoRows = await withDeadline(
        adsOsGaqlSearch(
          cid,
          `SELECT customer.id, customer.descriptive_name, customer.currency_code,
                  customer.time_zone, customer.status
           FROM customer LIMIT 1`,
        ),
        LIST_DEADLINE_MS,
        "Account probe",
      );
      const customer = (infoRows[0]?.customer ?? null) as Record<string, any> | null;
      const campRows = await withDeadline(
        adsOsGaqlSearch(cid, "SELECT campaign.id FROM campaign WHERE campaign.status = 'ENABLED'"),
        LIST_DEADLINE_MS,
        "Campaign probe",
      );
      res.json({
        customer_id: cid,
        account_name: acct?.descriptiveName ?? customer?.descriptiveName ?? cid,
        currency_code: customer?.currencyCode ?? null,
        time_zone: customer?.timeZone ?? null,
        status: customer?.status ?? null,
        enabled_campaigns: campRows.length,
      });
    } catch (err: any) {
      sendAdsOsError(res, err, "accounts/probe");
    }
  });

  // ── Phase 2+6: morning cron endpoint (spec §10, §8, §6.10) ────────────────
  // Scheduled background refresh: re-run budget pacing for every ENROLLED
  // account (incl. Off, so a recently switched-off account's stored budget
  // stays fresh) and persist each summary, so the dashboard pacing columns are
  // accurate every morning. One job refreshes BOTH products, then recomputes
  // every account's alerts (persisted for the dashboard badges), reconciles
  // open ClickUp tickets, and sends the only-on-change Slack digest.
  //
  // Auth is a shared secret (X-Cron-Key header == CRON_SECRET), not a session —
  // external schedulers can't log in. Disabled (401) when CRON_SECRET is unset.
  // Synchronous by design: the work happens inside the request.

  // Directory health probe (Task #3655): same X-Cron-Key auth as the pacing
  // cron so the production directory fetch can be verified WITHOUT a browser
  // session (no prod session can be minted). Returns the persisted health
  // snapshot; ?probe=1 additionally forces a live fetch in proof mode so the
  // response reports the REAL current outcome (success + client count, or the
  // exact error), not just the cached state.
  app.get("/api/ads-os/cron/clickup-health", async (req, res) => {
    const cronSecret = getCronSecret();
    if (!cronSecret || req.headers["x-cron-key"] !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const probe = String(req.query.probe ?? "") === "1" || String(req.query.probe ?? "") === "true";
    let probeResult: any = null;
    if (probe && (await isClickUpConfiguredAsync())) {
      try {
        const bundle = await getClientDirectory({ force: true, throwOnError: true });
        probeResult = {
          ok: true,
          clients: bundle.blocks.length,
          fetched_at: new Date(bundle.fetchedAt).toISOString(),
        };
      } catch (err: any) {
        probeResult = { ok: false, error: String(err?.message ?? err) };
      }
    }
    return res.json({ health: directoryHealth(), probe: probeResult });
  });

  app.post("/api/ads-os/cron/refresh-pacing", async (req, res) => {
    const cronSecret = getCronSecret();
    if (!cronSecret || req.headers["x-cron-key"] !== cronSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Verify every ClickUp-paused/off account against its real state (the
      // ✓/✗ on the Paused/Off chips) FIRST: it's the cheapest phase here (~a
      // dozen accounts, one query each) and the only one that persists a
      // single document at the end, so anywhere later in this request it
      // would be the first casualty of a deadline while pacing and alerts —
      // which persist per account — would already have banked most of theirs.
      // It warms the ClickUp directory the later phases need anyway.
      // Best-effort: a failure must not sink the job the dashboards depend on.
      let statusChecks: Record<string, any>;
      try {
        statusChecks = await runStatusChecks();
      } catch (err: any) {
        statusChecks = { error: String(err?.constructor?.name || err?.name || "Error") };
      }
      const gads = await refreshAllPacing();
      const lsa = await refreshAllLsaPacing();
      const alerts = await runAlerts(true);
      // The scheduler only ever looks at the HTTP status, so a verification
      // that computed but couldn't persist would return 200 forever and nobody
      // would know. Log it loudly — it's the one failure that is invisible in
      // the UI (bare chips look exactly like a check that never ran).
      if (statusChecks.saved === false || statusChecks.error) {
        console.error(
          "[AdsOs/statusCheck] cron: status checks not persisted:",
          JSON.stringify(statusChecks),
        );
      }
      return res.json({ gads, lsa, alerts, status_checks: statusChecks });
    } catch (err: any) {
      return sendAdsOsError(res, err, "cron/refresh-pacing");
    }
  });

  // ── Task #5157: Paid Search Role Cutover — admin endpoints ────────────────
  // All endpoints: isAuthenticated + requireCeo, strict Zod, bounded limits.

  /**
   * GET /api/ads-os/admin/paid-search-role-cutover
   * Bounded read-only preview: compares ClickUp parents to NoBull customers,
   * department members, assignments, and projection targets.
   * Returns at most 500 parent rows.
   */
  app.get(
    "/api/ads-os/admin/paid-search-role-cutover",
    isAuthenticated,
    requireCeo,
    async (_req, res) => {
      try {
        const preview = await buildPreview();
        return res.json(preview);
      } catch (err: any) {
        console.error("[AdsOs/paidSearchCutover/preview]", err?.message ?? err);
        return res.status(500).json({
          ok: false,
          error: "Preview failed. Check server logs for details.",
        });
      }
    },
  );

  /**
   * GET /api/ads-os/admin/paid-search-role-cutover/state
   * Returns the current cutover mode state (CEO-only).
   */
  app.get(
    "/api/ads-os/admin/paid-search-role-cutover/state",
    isAuthenticated,
    requireCeo,
    async (_req, res) => {
      try {
        const state = await getCutoverState();
        return res.json({ ok: true, state });
      } catch (err: any) {
        console.error("[AdsOs/paidSearchCutover/state/get]", err?.message ?? err);
        return res.status(500).json({ ok: false, error: "Failed to load state." });
      }
    },
  );

  /**
   * PUT /api/ads-os/admin/paid-search-role-cutover/state
   * Update cutover mode state. Validates business rules fail-closed.
   * Body: { action, mode?, projectionWritesEnabled? }
   */
  const CutoverStatePatchSchema = z.object({
    action: z.enum([
      "setMode",
      "setProjectionWritesEnabled",
      "approveRead",
      "revokeRead",
      "approveProjectionWrite",
      "revokeProjectionWrite",
    ] as [CutoverStateAction, ...CutoverStateAction[]]),
    mode: z.enum(CUTOVER_MODES).optional(),
    projectionWritesEnabled: z.boolean().optional(),
  }).strict();

  app.put(
    "/api/ads-os/admin/paid-search-role-cutover/state",
    isAuthenticated,
    requireCeo,
    async (req, res) => {
      const authReq = req as any;
      const actorId: string =
        authReq.dbUser?.id ?? authReq.user?.claims?.sub ?? "";
      if (!actorId) {
        return res.status(401).json({ ok: false, error: "Authenticated actor ID required." });
      }

      const parseResult = CutoverStatePatchSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          ok: false,
          error: "Invalid request body.",
          details: parseResult.error.flatten(),
        });
      }

      try {
        const result = await putCutoverState(parseResult.data, actorId, new Date());
        if (!result.ok) {
          return res.status(400).json(result);
        }
        return res.json(result);
      } catch (err: any) {
        console.error("[AdsOs/paidSearchCutover/state/put]", err?.message ?? err);
        return res.status(500).json({ ok: false, error: "Failed to update state." });
      }
    },
  );
}
