/**
 * Ads OS — configuration seam (port of backend/app/config.py from the source bundle).
 *
 * Reads every env var from spec §9 with the spec's defaults.
 * Secrets are read HERE and nowhere else in the Ads OS module.
 * Nothing in this module is ever serialized to the browser.
 *
 * Google Ads auth (Task #4008 unified model): the standalone env credentials
 * GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN
 * are the ONLY token source for EVERY Google Ads surface — Ads OS and the
 * platform integration alike (the old platform-managed google_ads_connection
 * row is retired; a refresh token only works with the OAuth client it was
 * minted under, else Google rejects the exchange with 401
 * unauthorized_client). All values are trimmed on read.
 *
 * OpenAI key: prefers OPENAI_API_KEY; falls back to AI_INTEGRATIONS_OPENAI_API_KEY
 * (NoBull platform key, per OPENAI.md and Task #3134).
 */

import { isRunningInDeployment } from "../../lib/deploymentEnv";
import {
  CANONICAL_PRODUCTION_LIST_ID,
  CLICKUP_DOER_FIELD_ID as CANONICAL_CLICKUP_DOER_FIELD_ID,
  CLICKUP_CHECKER_FIELD_ID as CANONICAL_CLICKUP_CHECKER_FIELD_ID,
  CLICKUP_PRACTICE_AREA_FIELD_ID as CANONICAL_CLICKUP_PRACTICE_AREA_FIELD_ID,
} from "./paidSearchRoleContract";

// ---------------------------------------------------------------------------
// Google Ads secrets
// ---------------------------------------------------------------------------

export function getDeveloperToken(): string {
  return (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
}

export function getClientId(): string {
  return (process.env.GOOGLE_ADS_CLIENT_ID || "").trim();
}

export function getClientSecret(): string {
  return (process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim();
}

export function getLoginCustomerId(): string {
  return (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/[^0-9]/g, "");
}

/**
 * Refresh-token sourcing (Task #4008): the GOOGLE_ADS_REFRESH_TOKEN env var is
 * the ONLY token source for every Google Ads surface. The refresh token must
 * be minted under the same OAuth client as GOOGLE_ADS_CLIENT_ID or Google
 * rejects the exchange with 401 unauthorized_client. Rotation therefore means
 * updating the matching trio together + restart (see GOOGLE_ADS.md runbook).
 */
export function getEnvRefreshToken(): string {
  return (process.env.GOOGLE_ADS_REFRESH_TOKEN || "").trim();
}

/**
 * Presence probe for the proofs/status panel: reports whether the env refresh
 * token is set. No token value is returned and nothing is minted.
 */
export function refreshTokenSource(): "env" | "none" {
  return getEnvRefreshToken() ? "env" : "none";
}

export function isGoogleAdsConfigured(): boolean {
  return !!(
    getDeveloperToken() &&
    getClientId() &&
    getClientSecret() &&
    getLoginCustomerId() &&
    (process.env.GOOGLE_ADS_REFRESH_TOKEN /* fast path — no await needed for the check */)
  );
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

/** Prefers OPENAI_API_KEY; falls back to AI_INTEGRATIONS_OPENAI_API_KEY. */
export function getOpenAiKey(): string {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    ""
  );
}

export function getOpenAiBaseUrl(): string | undefined {
  // Only override if using the platform key (which may have a base-URL proxy).
  if (process.env.OPENAI_API_KEY) return undefined; // own key → use OpenAI directly
  return process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined;
}

/** spec §9 default gpt-4o; overridable via OPENAI_MODEL. */
export function getOpenAiModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

/** Non-empty → send reasoning_effort; omit temperature (spec §9). */
export function getOpenAiReasoningEffort(): string {
  return process.env.OPENAI_REASONING_EFFORT || "";
}

/** Pyramid strategist model — spec §9 default gpt-5.5. */
export function getPyramidOpenAiModel(): string {
  return process.env.PYRAMID_OPENAI_MODEL || "gpt-5.5";
}

/** Pyramid reasoning effort — spec §9 default "medium". */
export function getPyramidReasoningEffort(): string {
  return process.env.PYRAMID_REASONING_EFFORT || "medium";
}

export function isOpenAiConfigured(): boolean {
  return !!getOpenAiKey();
}

// ---------------------------------------------------------------------------
// ClickUp
// ---------------------------------------------------------------------------

import {
  getClickUpCompanyTokenSnapshot,
  resolveClickUpCompanyToken,
  type ClickUpTokenSource,
} from "../clickUpCompanyToken";

/**
 * Task #3662 — the effective company token: DB override (rotatable at
 * runtime via Integrations Hub → ClickUp) → CLICKUP_API_TOKEN env fallback.
 * ALL Ads OS ClickUp fetches MUST resolve through this (async) accessor;
 * no direct env reads may remain at leaf fetches, or a runtime rotation
 * silently misses that consumer.
 */
export async function resolveClickUpToken(): Promise<string> {
  return (await resolveClickUpCompanyToken()).token;
}

/**
 * Sync configured-check from the last-known snapshot (env var or a
 * previously observed DB override). Cheap display/liveness gating only —
 * leaf fetches must use `resolveClickUpToken()` for the real credential.
 */
export function isClickUpConfigured(): boolean {
  return !!getClickUpCompanyTokenSnapshot().token;
}

/** Authoritative async configured-check (route gates, cron probes). */
export async function isClickUpConfiguredAsync(): Promise<boolean> {
  return !!(await resolveClickUpCompanyToken()).token;
}

/** Where the active token comes from (db | env | none) — status surfaces. */
export function clickUpTokenSource(): ClickUpTokenSource {
  return getClickUpCompanyTokenSnapshot().source;
}

// Client List (spec §3.2, §9). Development/staging may still override the
// directory contract, but deployed/production Ads OS is immovably pinned to
// the owner-approved canonical Client List and its existing Paid Search People
// fields throughout the cutover.
const PIN_CANONICAL_CLIENT_LIST =
  isRunningInDeployment() || process.env.NODE_ENV === "production";

export function resolveOperationalClickUpClientListId(
  env: NodeJS.ProcessEnv,
  productionRuntime: boolean,
): string {
  if (productionRuntime) return CANONICAL_PRODUCTION_LIST_ID;
  return env.CLICKUP_CLIENT_LIST_ID || CANONICAL_PRODUCTION_LIST_ID;
}

export const CLICKUP_CLIENT_LIST_ID = resolveOperationalClickUpClientListId(
  process.env,
  PIN_CANONICAL_CLIENT_LIST,
);
export const CLICKUP_CLIENT_CID_FIELD_ID = process.env.CLICKUP_CLIENT_CID_FIELD_ID || "a886aa6f-c7f8-41cc-940b-8afef551bf49";
export const CLICKUP_CLIENT_ADS_STATUS_FIELD_ID = process.env.CLICKUP_CLIENT_ADS_STATUS_FIELD_ID || "e8717288-345d-4a2b-8169-0992b78bc809";
export const CLICKUP_CLIENT_BUDGET_FIELD_ID = process.env.CLICKUP_CLIENT_BUDGET_FIELD_ID || "c57d3b29-e7a0-4373-82bf-b5590547f78c";
export const CLICKUP_DOER_FIELD_ID = PIN_CANONICAL_CLIENT_LIST
  ? CANONICAL_CLICKUP_DOER_FIELD_ID
  : process.env.CLICKUP_DOER_FIELD_ID || CANONICAL_CLICKUP_DOER_FIELD_ID;
export const CLICKUP_CHECKER_FIELD_ID = PIN_CANONICAL_CLIENT_LIST
  ? CANONICAL_CLICKUP_CHECKER_FIELD_ID
  : process.env.CLICKUP_CHECKER_FIELD_ID || CANONICAL_CLICKUP_CHECKER_FIELD_ID;

/** Practice Area is a pinned canonical-list contract, never env-overridden. */
export const CLICKUP_PRACTICE_AREA_FIELD_ID =
  CANONICAL_CLICKUP_PRACTICE_AREA_FIELD_ID;
export const CLICKUP_CLIENT_LOG_FIELD_ID = process.env.CLICKUP_CLIENT_LOG_FIELD_ID || "0d573e9c-d786-44f4-a5d3-ac86c20e7510";
// Alert ticket lists (spec §3.2)
export const CLICKUP_GADS_LIST_ID = process.env.CLICKUP_GADS_LIST_ID || "901417827107";
export const CLICKUP_LSA_LIST_ID = process.env.CLICKUP_LSA_LIST_ID || "901417827116";
// Client dropdown field on ticket tasks
export const CLICKUP_CLIENT_FIELD_ID = process.env.CLICKUP_CLIENT_FIELD_ID || "15f48f61-7481-4915-a3a2-468a8b9e9a8e";

/** Directory bundle age beyond which dashboards flag stale ClickUp data
 *  (Task #3608). Default 20 min — 2× the 10-min cache TTL, so a healthy
 *  refresh cadence never trips it; env-overridable in minutes. */
export const CLICKUP_STALE_AFTER_MS =
  parseInt(process.env.CLICKUP_STALE_AFTER_MINUTES || "20", 10) * 60 * 1000;

export function getClickUpExcludedStatuses(): Set<string> {
  const raw = process.env.CLICKUP_EXCLUDED_CLIENT_STATUSES || "offboarded";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Slack & cron
// ---------------------------------------------------------------------------

export function getSlackWebhookUrl(): string {
  return process.env.SLACK_WEBHOOK_URL || "";
}

export function isSlackConfigured(): boolean {
  return !!getSlackWebhookUrl();
}

export function getCronSecret(): string {
  return process.env.CRON_SECRET || "";
}

// ---------------------------------------------------------------------------
// Behavior settings (spec §9 defaults)
// ---------------------------------------------------------------------------

export const AUDIT_CACHE_TTL_SECONDS = parseInt(process.env.AUDIT_CACHE_TTL_SECONDS || "3600", 10);
export const DEFAULT_LOOKBACK_DAYS = parseInt(process.env.DEFAULT_LOOKBACK_DAYS || "30", 10);
export const KI_ACCOUNT_LABEL = process.env.KI_ACCOUNT_LABEL || "NBM_GADS_MONITOR";
export const KI_CAMPAIGN_LABEL = process.env.KI_CAMPAIGN_LABEL || "NBM_GADS_MONITOR_CAMPAIGN";
export const LSA_ACCOUNT_LABEL = process.env.LSA_ACCOUNT_LABEL || "NBM_LSA_MONITOR";
export const LSA_CAMPAIGN_LABEL = process.env.LSA_CAMPAIGN_LABEL || "NBM_LSA_MONITOR_CAMPAIGN";
export const KI_LOOKBACK_DAYS = parseInt(process.env.KI_LOOKBACK_DAYS || "7", 10);
export const KI_KEYWORD_LOOKBACK_DAYS = parseInt(process.env.KI_KEYWORD_LOOKBACK_DAYS || "30", 10);
export const KI_MIN_CONVERSIONS = parseFloat(process.env.KI_MIN_CONVERSIONS || "1.0");
export const KI_KEYWORD_MATCH_TYPE = process.env.KI_KEYWORD_MATCH_TYPE || "phrase";
export const KI_MAX_TERMS = parseInt(process.env.KI_MAX_TERMS || "500", 10);
export const KI_BATCH_SIZE = parseInt(process.env.KI_BATCH_SIZE || "40", 10);
export const KI_MIN_CONFIDENCE = parseFloat(process.env.KI_MIN_CONFIDENCE || "0.6");
export const KI_BROAD_MIN_CONFIDENCE = parseFloat(process.env.KI_BROAD_MIN_CONFIDENCE || "0.8");
export const KI_MIN_CONFIDENCE_SOFT = parseFloat(process.env.KI_MIN_CONFIDENCE_SOFT || "0.45");
export const LSA_LOOKBACK_DAYS = parseInt(process.env.LSA_LOOKBACK_DAYS || "30", 10);
export const LSA_ANSWERED_CALL_MIN_SECONDS = parseInt(process.env.LSA_ANSWERED_CALL_MIN_SECONDS || "0", 10);
export const LSA_ANSWER_RATE_GOOD = parseFloat(process.env.LSA_ANSWER_RATE_GOOD || "95");
export const LSA_LEAD_QUALITY_GOOD = parseFloat(process.env.LSA_LEAD_QUALITY_GOOD || "80");
export const ALERTS_SPEND_SPIKE_PCT = parseFloat(process.env.ALERTS_SPEND_SPIKE_PCT || "200");
export const ALERTS_NO_CONV_DAYS = parseInt(process.env.ALERTS_NO_CONV_DAYS || "7", 10);
// Canonical rolling-CPL alert policy. Deliberately fixed (not env/settings
// configurable): 30 complete days through yesterday, strictly above $350.
export const ALERTS_CPL_LOOKBACK_DAYS = 30;
export const ALERTS_CPL_THRESHOLD_DOLLARS = 350;
export const CLIENT_LOG_TAB = process.env.CLIENT_LOG_TAB || "Optimizations & Ideas";
export const CLIENT_LOG_SUMMARY_TTL_SECONDS = parseInt(process.env.CLIENT_LOG_SUMMARY_TTL_SECONDS || "86400", 10);
export const CLIENT_LOG_WINDOW_DAYS = parseInt(process.env.CLIENT_LOG_WINDOW_DAYS || "30", 10);
export const ACCOUNT_ENROLLMENT = process.env.ACCOUNT_ENROLLMENT || "auto";
// Pyramid thresholds (spec §9)
export const PYRAMID_LOOKBACK_DAYS = parseInt(process.env.PYRAMID_LOOKBACK_DAYS || "30", 10);
export const PYRAMID_MIN_CONV_FOR_BASELINE = parseFloat(process.env.PYRAMID_MIN_CONV_FOR_BASELINE || "3.0");
export const PYRAMID_KW_ZERO_CONV_MULT = parseFloat(process.env.PYRAMID_KW_ZERO_CONV_MULT || "2.0");
export const PYRAMID_KW_ONE_CONV_MULT = parseFloat(process.env.PYRAMID_KW_ONE_CONV_MULT || "3.0");
export const PYRAMID_KW_HIGH_CPL_MULT = parseFloat(process.env.PYRAMID_KW_HIGH_CPL_MULT || "2.0");
export const PYRAMID_AG_ZERO_CONV_MULT = parseFloat(process.env.PYRAMID_AG_ZERO_CONV_MULT || "2.0");
export const PYRAMID_AG_HIGH_CPL_MULT = parseFloat(process.env.PYRAMID_AG_HIGH_CPL_MULT || "2.0");
export const PYRAMID_CAMP_THROTTLE_MULT = parseFloat(process.env.PYRAMID_CAMP_THROTTLE_MULT || "2.0");
export const PYRAMID_CAMP_PAUSE_MULT = parseFloat(process.env.PYRAMID_CAMP_PAUSE_MULT || "3.0");
export const PYRAMID_CAMP_HIGH_CPL_MULT = parseFloat(process.env.PYRAMID_CAMP_HIGH_CPL_MULT || "2.0");
export const PYRAMID_SCALE_CPL_RATIO = parseFloat(process.env.PYRAMID_SCALE_CPL_RATIO || "0.85");
export const PYRAMID_SCALE_LOST_IS_BUDGET_PCT = parseFloat(process.env.PYRAMID_SCALE_LOST_IS_BUDGET_PCT || "10");
export const PYRAMID_RANK_LIMITED_IS_PCT = parseFloat(process.env.PYRAMID_RANK_LIMITED_IS_PCT || "20");
export const PYRAMID_MIN_SPEND_FOR_CALL = parseFloat(process.env.PYRAMID_MIN_SPEND_FOR_CALL || "25");
export const PYRAMID_MIN_CLICKS_FOR_CALL = parseInt(process.env.PYRAMID_MIN_CLICKS_FOR_CALL || "5", 10);
export const PYRAMID_THROTTLE_REDUCTION_PCT = parseFloat(process.env.PYRAMID_THROTTLE_REDUCTION_PCT || "30");
export const PYRAMID_MAX_TERMS = parseInt(process.env.PYRAMID_MAX_TERMS || "400", 10);
export const PYRAMID_TERM_BATCH_SIZE = parseInt(process.env.PYRAMID_TERM_BATCH_SIZE || "40", 10);
export const PYRAMID_MAX_FLAGGED_KEYWORDS = parseInt(process.env.PYRAMID_MAX_FLAGGED_KEYWORDS || "60", 10);
export const PYRAMID_MAX_AD_GROUPS_IN_PROMPT = parseInt(process.env.PYRAMID_MAX_AD_GROUPS_IN_PROMPT || "80", 10);
