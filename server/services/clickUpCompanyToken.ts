/**
 * Task #3662 — Runtime-rotatable ClickUp COMPANY token accessor.
 *
 * Why this exists: production deployments freeze env secrets at publish time.
 * When the ClickUp personal token was rotated after a publish, prod kept the
 * stale CLICKUP_API_TOKEN snapshot and the Ads OS Client List directory went
 * auth-dead (HTTP 401 "Oauth token not found") until someone republished —
 * twice. This accessor makes the token rotatable at RUNTIME: a DB-backed
 * override (system_settings key below) takes precedence over the env var,
 * which remains as bootstrap/fallback. An admin pastes a new token in the
 * Integrations Hub ClickUp card and every instance picks it up within
 * CACHE_TTL (default 30s) — no republish.
 *
 * Contract:
 *   - EVERY consumer of the company token routes through this module:
 *     Ads OS directory + config (`server/services/adsOs/config.ts`),
 *     Ads OS ticket pushes (`clickUpTasks.ts`), and the hygiene-alert
 *     surface (`server/services/clickUpClient.ts`). No direct
 *     `process.env.CLICKUP_API_TOKEN` reads may remain at leaf fetches.
 *   - The setting key ends in `_auth_token`, so BOTH the settings-cache
 *     deny-list lint (scripts/lint-settings-token-cache.ts) and the runtime
 *     suffix safety net force it to bypass the Redis read-through cache; it
 *     is also explicitly listed in SETTINGS_CACHE_DENYLIST for auditability.
 *     The token therefore never lands in Redis.
 *   - The token value is NEVER logged and NEVER returned by any API route.
 *     Status surfaces report only the SOURCE (db | env | none) + metadata.
 *   - Reads are cached in-process for a short TTL with single-flight, so the
 *     hot paths (directory refresh, ticket pushes) don't hammer the DB.
 *   - A failed DB read NEVER downgrades to "no token": last-known snapshot
 *     wins, else the env fallback (credential absent-vs-unknown memory rule).
 */

export type ClickUpTokenSource = "db" | "env" | "none";

export interface ResolvedClickUpCompanyToken {
  token: string; // "" when source === "none"
  source: ClickUpTokenSource;
}

/** system_settings key holding the runtime override. The `_auth_token`
 *  suffix is load-bearing: it puts the key under the token-bearing
 *  cache-bypass contract (lint + runtime safety net). */
export const CLICKUP_COMPANY_TOKEN_SETTING_KEY = "clickup_company_auth_token";

const DEFAULT_CACHE_TTL_MS = 30_000;

function configuredTtlMs(): number {
  const raw = parseInt(process.env.CLICKUP_COMPANY_TOKEN_CACHE_TTL_MS || "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

let _ttlMs = configuredTtlMs();

/** Injectable persistence seam. Tests swap this to avoid touching the real
 *  DB; production always uses the settingsStorage-backed default. */
export interface ClickUpCompanyTokenStore {
  get(key: string): Promise<
    { value: string | null; updatedAt?: Date | null; updatedBy?: string | null } | undefined
  >;
  set(key: string, value: string, updatedBy?: string): Promise<void>;
  del(key: string): Promise<void>;
  recordAudit(event: "set" | "cleared", changedBy: string | null): Promise<void>;
}

const defaultStore: ClickUpCompanyTokenStore = {
  async get(key) {
    const { getSystemSetting } = await import("../storage/settingsStorage");
    const row = await getSystemSetting(key);
    return row
      ? { value: row.value, updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ?? null }
      : undefined;
  },
  async set(key, value, updatedBy) {
    const { setSystemSetting } = await import("../storage/settingsStorage");
    await setSystemSetting(key, value, updatedBy);
  },
  async del(key) {
    const { deleteSystemSetting } = await import("../storage/settingsStorage");
    await deleteSystemSetting(key);
  },
  async recordAudit(event, changedBy) {
    const { recordAdminSettingChange } = await import("../storage/settingsStorage");
    await recordAdminSettingChange({
      settingKey: CLICKUP_COMPANY_TOKEN_SETTING_KEY,
      scope: event,
      changedBy,
      oldValues: null,
      // Event breadcrumb only — the token value itself is NEVER audited.
      newValues: { event },
    });
  },
};

let _store: ClickUpCompanyTokenStore | null = null;

function store(): ClickUpCompanyTokenStore {
  return _store ?? defaultStore;
}

function envClickUpToken(): string {
  return (process.env.CLICKUP_API_TOKEN || "").trim();
}

/**
 * Display-only helper so no other module needs to touch
 * `process.env.CLICKUP_API_TOKEN` directly (e.g. the clear route's
 * source fallback when the status read fails). Never exposes the value.
 */
export function isClickUpEnvTokenPresent(): boolean {
  return envClickUpToken().length > 0;
}

let _snapshot: { token: string; source: ClickUpTokenSource; at: number } | null = null;
let _inFlight: Promise<ResolvedClickUpCompanyToken> | null = null;
let _lastReadErrorLoggedAt = 0;

function resolveFrom(dbToken: string): ResolvedClickUpCompanyToken {
  if (dbToken) return { token: dbToken, source: "db" };
  const envToken = envClickUpToken();
  if (envToken) return { token: envToken, source: "env" };
  return { token: "", source: "none" };
}

/**
 * Resolve the effective company token: DB override → env fallback → none.
 * Cached in-process for the TTL; single-flight so concurrent cold reads hit
 * the DB once. Never throws; never logs the token value.
 */
export async function resolveClickUpCompanyToken(): Promise<ResolvedClickUpCompanyToken> {
  const now = Date.now();
  if (_snapshot && now - _snapshot.at < _ttlMs) {
    return { token: _snapshot.token, source: _snapshot.source };
  }
  if (_inFlight) return _inFlight;
  _inFlight = (async (): Promise<ResolvedClickUpCompanyToken> => {
    try {
      const row = await store().get(CLICKUP_COMPANY_TOKEN_SETTING_KEY);
      const resolved = resolveFrom((row?.value ?? "").trim());
      _snapshot = { ...resolved, at: Date.now() };
      return resolved;
    } catch (err: any) {
      // Failed settings read ≠ "no token". Prefer the last value this process
      // positively observed; else fall back to env. The snapshot is NOT
      // re-stamped, so the next call past the TTL retries the DB.
      if (Date.now() - _lastReadErrorLoggedAt > 60_000) {
        _lastReadErrorLoggedAt = Date.now();
        console.warn(
          `[ClickUpCompanyToken] settings read failed (using ${_snapshot ? "last-known" : "env fallback"}):`,
          err?.message ?? err,
        );
      }
      if (_snapshot) return { token: _snapshot.token, source: _snapshot.source };
      return resolveFrom("");
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Sync last-known view — for cheap `isConfigured()`-style gates that cannot
 * await. Uses the last resolved snapshot regardless of age (a stale positive
 * beats a false "unconfigured"), else the env fallback. Leaf fetches must
 * NEVER use this for the actual Authorization header; they resolve async.
 */
export function getClickUpCompanyTokenSnapshot(): ResolvedClickUpCompanyToken {
  if (_snapshot) return { token: _snapshot.token, source: _snapshot.source };
  return resolveFrom("");
}

/** Drop the in-process cache so the next resolve re-reads the DB. */
export function invalidateClickUpCompanyTokenCache(): void {
  _snapshot = null;
  _inFlight = null;
}

/**
 * Save/rotate the runtime override. Write-through: the in-process snapshot
 * is updated immediately (other instances converge within the TTL). Audits
 * an event breadcrumb only — never the value.
 */
export async function setClickUpCompanyToken(token: string, updatedBy?: string | null): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("ClickUp token must not be empty");
  await store().set(CLICKUP_COMPANY_TOKEN_SETTING_KEY, trimmed, updatedBy ?? undefined);
  _snapshot = { token: trimmed, source: "db", at: Date.now() };
  _inFlight = null;
  try {
    await store().recordAudit("set", updatedBy && updatedBy !== "system" ? updatedBy : null);
  } catch (err: any) {
    console.error("[ClickUpCompanyToken] rotate audit insert failed:", err?.message ?? err);
  }
}

/** Remove the runtime override (reverts to the env bootstrap token). */
export async function clearClickUpCompanyToken(updatedBy?: string | null): Promise<void> {
  await store().del(CLICKUP_COMPANY_TOKEN_SETTING_KEY);
  invalidateClickUpCompanyTokenCache();
  try {
    await store().recordAudit("cleared", updatedBy && updatedBy !== "system" ? updatedBy : null);
  } catch (err: any) {
    console.error("[ClickUpCompanyToken] clear audit insert failed:", err?.message ?? err);
  }
}

/**
 * Admin-surface status: source + metadata, never the token. THROWS when the
 * settings read fails so the route can answer 503 statusUnknown instead of
 * a false "not configured" (absent-vs-unknown contract).
 */
export async function getClickUpCompanyTokenStatus(): Promise<{
  configured: boolean;
  source: ClickUpTokenSource;
  envPresent: boolean;
  dbOverride: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}> {
  const row = await store().get(CLICKUP_COMPANY_TOKEN_SETTING_KEY);
  const dbToken = (row?.value ?? "").trim();
  const resolved = resolveFrom(dbToken);
  // Keep the hot-path snapshot warm with the authoritative read.
  _snapshot = { ...resolved, at: Date.now() };
  return {
    configured: resolved.source !== "none",
    source: resolved.source,
    envPresent: !!envClickUpToken(),
    dbOverride: !!dbToken,
    updatedAt: dbToken && row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    updatedBy: dbToken ? row?.updatedBy ?? null : null,
  };
}

// ─── Test seams (production never calls these) ───────────────────────────────

export function __setClickUpCompanyTokenStoreForTest(s: ClickUpCompanyTokenStore | null): void {
  _store = s;
  invalidateClickUpCompanyTokenCache();
}

export function __setClickUpCompanyTokenTtlForTest(ms: number | null): void {
  _ttlMs = ms === null ? configuredTtlMs() : ms;
}

export function __resetClickUpCompanyTokenForTest(): void {
  _store = null;
  _snapshot = null;
  _inFlight = null;
  _ttlMs = configuredTtlMs();
  _lastReadErrorLoggedAt = 0;
}
