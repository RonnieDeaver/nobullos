// @db-pool-intent: ambient
  //
  // Task #1721 Phase 2.1 / Task #1723: this file calls `getDb()`. The
  // intent above declares which pool every `getDb()` call in this
  // module is expected to land on. See `scripts/lint-db-pool-tenancy.ts`
  // for the contract and `server/db.ts` for the routing.

  import {
  type PracticeAreaSetting, type InsertPracticeAreaSetting, practiceAreaSettings,
  type PhaseSetting, type InsertPhaseSetting, phaseSettings,
  type SystemSetting, systemSettings,
  type StaleLeaseThresholdAudit, type InsertStaleLeaseThresholdAudit, staleLeaseThresholdAudit,
  type AdminSettingAudit, type InsertAdminSettingAudit, adminSettingAudit,
  type QueueTimingAudit, type InsertQueueTimingAudit, queueTimingAudit,
} from "@shared/schema";
import { getDb, withDbAttribution } from "../db";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { cacheDel, cacheGetOrSet, cacheSet } from "../services/cache/redisCache";

// DB Scale Layer Phase 2: cache namespace for system_settings.
// Kept short because the prefix is concatenated into every key by
// the cache helper (`nobull:${env}:system_settings:${key}`).
const SYSTEM_SETTINGS_NS = "system_settings";

// Keys that must NEVER be served from the Redis read-through cache.
// These keys hold OAuth tokens, credentials, or other rotating secrets.
// Serving a stale cached token after a rotation causes 401 storms
// (Zoom code 124 "Invalid access token."; SEMrush / Front same pattern).
// The Redis cache layer's own written contract states: "No truth in Redis.
// OAuth tokens … are explicitly excluded at the call site." This Set is
// that exclusion, enforced by a lint guard (scripts/lint-settings-token-cache.ts,
// gated via tests/lint-settings-token-cache.test.ts).
//
// ─── MAINTENANCE CONTRACT (new integrations) ───────────────────────────────
// When wiring a NEW integration whose connection/store path writes OAuth
// tokens, rotating API secrets, or short-lived credentials into
// system_settings, its token keys MUST be added to this deny-list (or
// SETTINGS_CACHE_DENYLIST_PREFIXES for per-user dynamic keys) BEFORE the
// integration's first production rotation. Do it in the same PR that
// introduces the keys — the same PR that creates/extends the integration's
// owning runbook per the Integration Runbook Coverage Matrix in RUNBOOKS.md
// (see also replit.md § Doc Hygiene).
//
// Three layers keep this honest:
//   1. This explicit list — the documented source of truth per key.
//   2. The lint guard (scripts/lint-settings-token-cache.ts): fails CI when a
//      token-bearing key literal appears in server/ but not here. It cannot
//      see keys built at runtime (template literals, concatenation) or keys
//      written only via DB-only paths.
//   3. The runtime suffix safety net below (TOKEN_BEARING_KEY_SUFFIXES):
//      any key whose name matches a token-bearing suffix bypasses the Redis
//      cache even if a developer forgets layers 1–2. The safety net is a
//      backstop, NOT a substitute — explicit listing keeps the inventory
//      auditable and keeps the lint's naming-pattern list in lockstep.
export const SETTINGS_CACHE_DENYLIST: ReadonlySet<string> = new Set([
  // Zoom OAuth tokens (rotating: 1-hour access token + ~1-hour refresh token)
  "zoom_access_token",
  "zoom_refresh_token",
  "zoom_token_expires_at",
  "zoom_oauth_state",
  // Front OAuth tokens (6-month rotating access + refresh)
  "front_access_token",
  "front_refresh_token",
  "front_token_expires_at",
  "front_oauth_state",
  // SEMrush OAuth tokens (7-day access; device-flow intermediate credentials)
  "semrush_access_token",
  "semrush_refresh_token",
  "semrush_token_expires_at",
  "semrush_device_code",
  "semrush_user_code",
  "semrush_device_expires_at",
  // Twilio credentials
  "twilio_auth_token",
  "twilio_api_key_secret",
  // Stripe secret key
  "stripe_secret_key",
  // Slack OAuth token
  "slack_bot_token",
  // Auth-breaker persisted state keys — low-read-rate, correctness-critical.
  // Even same-environment 5-minute staleness undermines the persist/hydrate/
  // reconcile design: a stale cached "tripped" value keeps the badge stuck
  // "disconnected" while the DB already shows the breaker cleared (and vice
  // versa). These must always reflect the environment's own DB truth.
  "semrush_auth_breaker_state",
  "front_auth_breaker_state",
  // Legacy Google service-account key (now only the Sheets-lane fallback —
  // Task #4084 retired the Drive integration). Credential material: a leaked
  // test fixture cached in Redis would poison reads for the full 5-minute
  // TTL. Always read from the environment's own DB.
  "google_service_account_key",
  // Task #3662: ClickUp COMPANY token runtime override (rotatable via the
  // Integrations Hub — deployments freeze env secrets, so rotation must not
  // require a republish). Credential material: must never land in Redis, and
  // a stale cached read would serve a just-rotated-away token for the TTL.
  // Also covered by the `_auth_token` suffix net; listed for auditability.
  "clickup_company_auth_token",
]);

// Dynamic-key prefixes that must ALSO bypass the Redis read-through cache.
// Some rotating credentials are stored under per-user keys (a fixed prefix
// plus a user id), so they can never appear in the exact-key Set above.
// Task #3129: single-use OAuth state nonces live at `<provider>_oauth_nonce:
// <userId>`. A stale cached read of a consumed nonce would let an old OAuth
// `state` replay within the cache TTL, so nonce reads must always hit the DB.
// (The `google_ads_oauth_nonce:` prefix retired with the in-app Google Ads
// OAuth flow — Task #4008.)
export const SETTINGS_CACHE_DENYLIST_PREFIXES: readonly string[] = [
  "clickup_oauth_nonce:",
  "google_calendar_oauth_nonce:",
];

// Runtime suffix safety net (layer 3 of the maintenance contract above).
// Any system_settings key whose NAME part matches one of these suffixes is
// treated as token-bearing and bypasses the Redis read-through cache, even
// when the key was built at runtime (template literals, concatenation) or
// written via a DB-only path — the cases the lint guard cannot see. This
// list must stay in lockstep with TOKEN_BEARING_SUFFIXES in
// scripts/lint-settings-token-cache.ts; the lint enforces the lockstep by
// parsing this array from this file and comparing.
export const TOKEN_BEARING_KEY_SUFFIXES: readonly string[] = [
  "_access_token",
  "_refresh_token",
  "_token_expires_at",
  "_auth_token",
  "_api_key_secret",
  "_secret_key",
  "_client_secret",
  "_device_code",
  "_device_expires_at",
  "_oauth_state",
  "_bot_token",
  "_user_code",
  // Prefix-only credential patterns (per-user single-use nonces). These only
  // ever appear as `<name>_oauth_nonce:<userId>` keys; the name part before
  // the ":" is what gets suffix-matched below.
  "_oauth_nonce",
  "_nonce",
];

// Credential-STRUCTURE words (Task #3401, extends the Task #3394 lint rule
// to runtime). `google_service_account_key` ends in `_key` — NOT a recognized
// token-bearing suffix — so the suffix safety net above would never catch a
// runtime-built sibling like `acme_service_account_key` written only via
// DB paths the lint can't see; it would sit in Redis for the full 5-minute
// TTL. Any key whose NAME part CONTAINS one of these words bypasses the
// cache. Bare-word matches are excluded: a name that IS exactly the
// structure word (e.g. the JSON field name "private_key" inside a parsed
// service-account blob) is a field name, not a settings key — settings keys
// always carry a provider prefix. This list must stay in lockstep with
// CREDENTIAL_STRUCTURE_WORDS in scripts/lint-settings-token-cache.ts; the
// lint enforces the lockstep by parsing this array and comparing.
export const CREDENTIAL_STRUCTURE_KEY_WORDS: readonly string[] = [
  "service_account",
  "private_key",
  "pkcs",
  "credentials_json",
  "keyfile",
];

// Single predicate both read paths use. Exact keys OR denylisted prefixes OR
// the token-bearing suffix safety net OR the credential-structure-word net
// (both matched against the key's name part — the substring before the
// first ":" for dynamic per-user keys).
export function isSettingsCacheDenylisted(key: string): boolean {
  if (SETTINGS_CACHE_DENYLIST.has(key)) return true;
  if (SETTINGS_CACHE_DENYLIST_PREFIXES.some((p) => key.startsWith(p))) return true;
  const colonIdx = key.indexOf(":");
  const namePart = colonIdx === -1 ? key : key.slice(0, colonIdx);
  if (TOKEN_BEARING_KEY_SUFFIXES.some((suf) => namePart.endsWith(suf))) return true;
  return CREDENTIAL_STRUCTURE_KEY_WORDS.some(
    (word) => namePart.includes(word) && namePart !== word,
  );
}

// 5 minutes. system_settings entries are hammered on every request
// (kill switch lookups, rate-limit multipliers, queue gates) and
// writes are rare and explicit (CEO actions, admin UI). The TTL is
// a safety net only — every `setSystemSetting` / `deleteSystemSetting`
// call invalidates the affected key inline, so callers see writes
// immediately. The TTL bounds drift in the unlikely case a write
// happens on a different process that fails to invalidate (which
// can't happen in our single-app deployment today, but is the
// correctness guarantee Redis offers when we add replicas).
const SYSTEM_SETTINGS_TTL_SECONDS = 300;

// Sentinel cached for missing rows so we don't re-hit the DB every
// request for a key that doesn't exist. Stored as a small marker
// object; reader unwraps back to `undefined`.
type CachedSystemSetting =
  | { kind: "hit"; row: SystemSetting }
  | { kind: "miss" };

export async function getPracticeAreaSettings(): Promise<PracticeAreaSetting[]> {
  return getDb().select().from(practiceAreaSettings).orderBy(practiceAreaSettings.practiceArea);
}

export async function getPracticeAreaSetting(practiceArea: string): Promise<PracticeAreaSetting | undefined> {
  const [setting] = await getDb().select().from(practiceAreaSettings)
    .where(sql`lower(${practiceAreaSettings.practiceArea}) = lower(${practiceArea})`);
  return setting;
}

export async function upsertPracticeAreaSetting(data: InsertPracticeAreaSetting): Promise<PracticeAreaSetting> {
  const existing = await getPracticeAreaSetting(data.practiceArea);

  if (existing) {
    const [updated] = await getDb().update(practiceAreaSettings)
      .set({
        searchTerm: data.searchTerm,
        monthlyData: data.monthlyData,
        isActive: data.isActive,
        updatedAt: new Date(),
      })
      .where(eq(practiceAreaSettings.id, existing.id))
      .returning();
    return updated;
  }

  const [setting] = await getDb().insert(practiceAreaSettings)
    .values(data)
    .returning();
  return setting;
}

export async function deletePracticeAreaSetting(id: string): Promise<void> {
  await getDb().delete(practiceAreaSettings).where(eq(practiceAreaSettings.id, id));
}

export async function getPhaseSettings(): Promise<PhaseSetting[]> {
  return getDb().select().from(phaseSettings);
}

export async function upsertPhaseSetting(data: InsertPhaseSetting): Promise<PhaseSetting> {
  const existing = await getDb().select().from(phaseSettings).where(eq(phaseSettings.phase, data.phase));

  if (existing.length > 0) {
    const [updated] = await getDb().update(phaseSettings)
      .set({
        actions: data.actions,
        updatedBy: data.updatedBy,
        updatedAt: new Date(),
      })
      .where(eq(phaseSettings.phase, data.phase))
      .returning();
    return updated;
  }

  const [setting] = await getDb().insert(phaseSettings).values(data).returning();
  return setting;
}

// DB Scale Layer Phase 2: read-through Redis cache wrapper.
//
// When the kill switch is on AND Upstash is reachable, this serves
// from Redis with a 5-minute TTL and falls back to the DB loader on
// miss. When the switch is off OR Upstash is unreachable, the cache
// helper bypasses transparently and we hit the DB directly. Every
// `setSystemSetting` / `deleteSystemSetting` invalidates the same
// key inline so writes are immediately visible.
//
// Cache shape per key:
//   namespace = "system_settings"
//   key       = the raw setting key (e.g. "redis_cache_enabled")
//   value     = { kind: "hit", row } | { kind: "miss" }
//
// The "miss" sentinel exists so we don't pound the DB looking up a
// known-missing key on every request (e.g. a kill switch the
// operator hasn't created yet).
export async function getSystemSetting(key: string): Promise<SystemSetting | undefined> {
  // Token-bearing keys bypass Redis entirely — a stale cached token after a
  // rotation opens a window where every read returns the old (now-invalid)
  // token, causing 401 storms (Zoom code 124, SEMrush, Front). The
  // setSystemSetting cacheDel runs AFTER the DB write, so a concurrent
  // cacheGetOrSet that read the old row can re-pin it in Redis for up to
  // 5 minutes. Bypass = always DB truth. See SETTINGS_CACHE_DENYLIST.
  if (isSettingsCacheDenylisted(key)) {
    const [row] = await getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key));
    return row ? reviveSystemSettingDates(row) : undefined;
  }

  const cached = await cacheGetOrSet<CachedSystemSetting>(
    SYSTEM_SETTINGS_NS,
    key,
    async () => {
      const [row] = await getDb()
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, key));
      return row ? { kind: "hit", row } : { kind: "miss" };
    },
    { ttlSeconds: SYSTEM_SETTINGS_TTL_SECONDS },
  );
  if (!cached || cached.kind === "miss") return undefined;
  // Re-hydrate Date fields. JSON serialization through Redis turns
  // `updatedAt: Date` into a string; consumers expect a Date so they
  // can do comparisons / formatting. Same for any other Date columns.
  return reviveSystemSettingDates(cached.row);
}

function reviveSystemSettingDates(row: SystemSetting): SystemSetting {
  return {
    ...row,
    updatedAt:
      row.updatedAt != null && !(row.updatedAt instanceof Date)
        ? new Date(row.updatedAt as unknown as string)
        : row.updatedAt,
  };
}

/**
 * Task #2412 — authoritative, cache-bypassing read of a single system
 * setting. Reads straight from the DB (skipping the Redis read-through),
 * then RE-PRIMES the cache with the observed truth so a stale negative
 * `{kind:"miss"}` sentinel — or any cached/transient empty read — can no
 * longer mask a live row for the rest of its TTL.
 *
 * Use this on the rare confirm path where a falsy cached read must be
 * distinguished from a CONFIRMED absence before doing anything terminal
 * (e.g. the SEMrush auth-breaker `getAccessToken` confirm-before-trip).
 * The hot happy-path read should keep using `getSystemSetting` (cached)
 * for speed.
 *
 * Unlike `getSystemSetting`, the DB read here is allowed to throw: the
 * caller must distinguish "confirmed empty" (resolves to `undefined`)
 * from "read failed / unknown" (rejects) — collapsing the two is exactly
 * the absent-vs-unknown bug this guards against.
 */
export async function getSystemSettingFresh(key: string): Promise<SystemSetting | undefined> {
  const [row] = await withDbAttribution("settings:getSystemSettingFresh", () =>
    getDb()
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, key)),
  );
  // Re-prime the read-through cache so subsequent cached reads converge on
  // the freshly-observed truth. `cacheSet` is a no-op when the cache is
  // inactive and swallows its own errors, so this never affects the result.
  await cacheSet<CachedSystemSetting>(
    SYSTEM_SETTINGS_NS,
    key,
    row ? { kind: "hit", row } : { kind: "miss" },
    { ttlSeconds: SYSTEM_SETTINGS_TTL_SECONDS },
  );
  return row ? reviveSystemSettingDates(row) : undefined;
}

// Task #836 Phase 5: batched read used by callers that previously
// fanned out N parallel `getSystemSetting` calls (e.g. the Zoom
// review queue alert tick, which read 11 settings). DB Scale Layer
// Phase 2: now goes through the per-key Redis cache too. On a full
// cache hit this is 0 DB queries; on partial / cold cache it falls
// back to a single batched `IN (...)` query for the missing keys
// and primes the cache for next time. Returns a key→value map;
// missing keys are absent.
export async function getSystemSettings(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};

  // Partition: deny-listed keys go straight to the DB (no Redis populate),
  // the rest flow through the read-through cache. See SETTINGS_CACHE_DENYLIST.
  const bypassKeys = keys.filter((k) => isSettingsCacheDenylisted(k));
  const cachedKeys = keys.filter((k) => !isSettingsCacheDenylisted(k));

  const out: Record<string, string> = {};

  // Direct DB read for token-bearing keys (no cache, no populate).
  if (bypassKeys.length > 0) {
    const bypassRows = await getDb()
      .select()
      .from(systemSettings)
      .where(inArray(systemSettings.key, bypassKeys));
    for (const row of bypassRows) {
      if (row.value != null) out[row.key] = row.value;
    }
  }

  if (cachedKeys.length === 0) return out;

  // Fan out per-key cache lookups in parallel. Each call either
  // serves from Redis, or runs its own loader (which hits the DB
  // with `eq(...)`). That's a worst-case-N queries vs the single
  // `IN (...)` batched query before. We keep the batched fallback
  // path for the cold-cache case: pre-resolve known-cached keys
  // via cacheGetOrSet AFTER we know which keys are unknown.
  //
  // Implementation: do a single peek (cacheGet) for each key first
  // to identify the unknown set; batch-load the unknowns from DB in
  // ONE query; then prime the cache for each loaded row. This
  // collapses the worst case back to 1 DB query while keeping the
  // cache hot.
  const { cacheGet, cacheSet } = await import("../services/cache/redisCache");
  const peeks = await Promise.all(
    cachedKeys.map((k) => cacheGet<CachedSystemSetting>(SYSTEM_SETTINGS_NS, k)),
  );

  const unknownKeys: string[] = [];

  for (let i = 0; i < cachedKeys.length; i++) {
    const key = cachedKeys[i];
    const cached = peeks[i];
    if (cached == null) {
      unknownKeys.push(key);
    } else if (cached.kind === "hit" && cached.row.value != null) {
      out[key] = cached.row.value;
    }
    // cached.kind === "miss" → key known to not exist, nothing to add.
  }

  if (unknownKeys.length === 0) return out;

  // Single batched DB read for the unknown keys. This preserves the
  // Task #836 N+1 fix on a cold cache.
  const rows = await getDb()
    .select()
    .from(systemSettings)
    .where(inArray(systemSettings.key, unknownKeys));

  const foundKeys = new Set<string>();
  await Promise.all(
    rows.map(async (row) => {
      foundKeys.add(row.key);
      if (row.value != null) out[row.key] = row.value;
      await cacheSet<CachedSystemSetting>(
        SYSTEM_SETTINGS_NS,
        row.key,
        { kind: "hit", row },
        { ttlSeconds: SYSTEM_SETTINGS_TTL_SECONDS },
      );
    }),
  );

  // Prime "miss" sentinel for unknown keys that didn't return a row,
  // so repeated probes for nonexistent settings don't pound the DB.
  await Promise.all(
    unknownKeys
      .filter((k) => !foundKeys.has(k))
      .map((k) =>
        cacheSet<CachedSystemSetting>(
          SYSTEM_SETTINGS_NS,
          k,
          { kind: "miss" },
          { ttlSeconds: SYSTEM_SETTINGS_TTL_SECONDS },
        ),
      ),
  );

  return out;
}

// Synthetic actor markers used by background workers / system code paths.
// These are NOT real user IDs and must be coerced to NULL before write,
// otherwise the system_settings.updated_by → users.id FK rejects them
// (e.g. "[WorkScheduler] Failed to persist dispatch window history:
// insert or update on table "system_settings" violates foreign key
// constraint "system_settings_updated_by_users_id_fk").
const SYNTHETIC_UPDATED_BY_MARKERS = new Set([
  "system",
  "scheduler",
  "worker",
  "cron",
  "test",
]);

export async function setSystemSetting(key: string, value: string, updatedBy?: string): Promise<SystemSetting> {
  const safeUpdatedBy =
    updatedBy && !SYNTHETIC_UPDATED_BY_MARKERS.has(updatedBy) ? updatedBy : null;
  const existing = await getDb().select().from(systemSettings).where(eq(systemSettings.key, key));

  let result: SystemSetting;
  if (existing.length > 0) {
    const [updated] = await getDb().update(systemSettings)
      .set({
        value,
        updatedBy: safeUpdatedBy,
        updatedAt: new Date(),
      })
      .where(eq(systemSettings.key, key))
      .returning();
    result = updated;
  } else {
    const [setting] = await getDb().insert(systemSettings).values({
      key,
      value,
      updatedBy: safeUpdatedBy,
    }).returning();
    result = setting;
  }

  // DB Scale Layer Phase 2: invalidate the Redis cache for this key
  // AFTER the DB write succeeds. Fail-open: cache invalidation
  // failure is logged inside the helper but never throws past it,
  // so a Redis outage cannot block writes. Worst case: readers see
  // the previous value until the 5-min TTL expires.
  await cacheDel(SYSTEM_SETTINGS_NS, key);

  return result;
}

export async function deleteSystemSetting(key: string): Promise<void> {
  await getDb().delete(systemSettings).where(eq(systemSettings.key, key));
  // DB Scale Layer Phase 2: see comment in `setSystemSetting`.
  await cacheDel(SYSTEM_SETTINGS_NS, key);
}

export async function recordStaleLeaseThresholdChange(
  data: InsertStaleLeaseThresholdAudit,
): Promise<StaleLeaseThresholdAudit> {
  const [row] = await getDb().insert(staleLeaseThresholdAudit).values(data).returning();
  return row;
}

export async function listStaleLeaseThresholdAudit(limit = 10): Promise<StaleLeaseThresholdAudit[]> {
  return getDb().select().from(staleLeaseThresholdAudit)
    .orderBy(desc(staleLeaseThresholdAudit.changedAt))
    .limit(limit);
}

export async function pruneStaleLeaseThresholdAudit(opts: {
  maxEntries?: number;
  maxAgeDays?: number;
}): Promise<number> {
  let pruned = 0;

  if (opts.maxAgeDays !== undefined && opts.maxAgeDays > 0) {
    const days = Math.floor(opts.maxAgeDays);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await getDb()
      .delete(staleLeaseThresholdAudit)
      .where(lt(staleLeaseThresholdAudit.changedAt, cutoff))
      .returning({ id: staleLeaseThresholdAudit.id });
    pruned += deleted.length;
  }

  if (opts.maxEntries !== undefined && opts.maxEntries > 0) {
    const keep = Math.floor(opts.maxEntries);
    const survivors = await getDb()
      .select({ id: staleLeaseThresholdAudit.id })
      .from(staleLeaseThresholdAudit)
      .orderBy(desc(staleLeaseThresholdAudit.changedAt))
      .limit(keep);
    const keepIds = survivors.map((row) => row.id);
    const deleted = keepIds.length > 0
      ? await getDb()
          .delete(staleLeaseThresholdAudit)
          .where(notInArray(staleLeaseThresholdAudit.id, keepIds))
          .returning({ id: staleLeaseThresholdAudit.id })
      : await getDb()
          .delete(staleLeaseThresholdAudit)
          .returning({ id: staleLeaseThresholdAudit.id });
    pruned += deleted.length;
  }

  return pruned;
}

/**
 * Read-only estimate of how many `stale_lease_threshold_audit` rows would be
 * removed by the next prune given the supplied bounds. Performs no writes.
 *
 * Mirrors `pruneStaleLeaseThresholdAudit` semantics: a row is "would-remove"
 * if it is older than `maxAgeDays` OR its rank (newest first) exceeds
 * `maxEntries`. A bound of `undefined` / `<= 0` is ignored.
 */
export async function estimatePruneStaleLeaseThresholdAudit(opts: {
  maxEntries?: number;
  maxAgeDays?: number;
}): Promise<{ wouldRemove: number; total: number }> {
  const totalRows = await getDb()
    .execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM ${staleLeaseThresholdAudit}`);
  const total = Number(totalRows.rows?.[0]?.count ?? 0);

  const hasAge = opts.maxAgeDays !== undefined && opts.maxAgeDays > 0;
  const hasEntries = opts.maxEntries !== undefined && opts.maxEntries > 0;
  if (!hasAge && !hasEntries) return { wouldRemove: 0, total };

  const cutoff = hasAge
    ? new Date(Date.now() - Math.floor(opts.maxAgeDays!) * 24 * 60 * 60 * 1000)
    : null;
  const keep = hasEntries ? Math.floor(opts.maxEntries!) : 0;

  const ageCond = hasAge ? sql`changed_at < ${cutoff}` : sql`false`;
  const entriesCond = hasEntries ? sql`rn > ${keep}` : sql`false`;

  const result = await getDb().execute<{ count: string }>(sql`
    WITH ranked AS (
      SELECT id, changed_at,
        row_number() OVER (ORDER BY changed_at DESC, id DESC) AS rn
      FROM ${staleLeaseThresholdAudit}
    )
    SELECT count(*)::text AS count FROM ranked
    WHERE (${ageCond}) OR (${entriesCond})
  `);
  const wouldRemove = Number(result.rows?.[0]?.count ?? 0);
  return { wouldRemove, total };
}

let queueTimingAuditTableReady: Promise<void> | null = null;

export async function ensureQueueTimingAuditTable(): Promise<void> {
  if (!queueTimingAuditTableReady) {
    queueTimingAuditTableReady = (async () => {
      await getDb().execute(sql`
        CREATE TABLE IF NOT EXISTS "queue_timing_audit" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "changed_by" varchar REFERENCES users(id),
          "old_values" jsonb,
          "new_values" jsonb NOT NULL,
          "changed_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await getDb().execute(sql`
        CREATE INDEX IF NOT EXISTS "queue_timing_audit_changed_at_idx"
          ON "queue_timing_audit" ("changed_at" DESC)
      `);
    })().catch((err) => {
      queueTimingAuditTableReady = null;
      throw err;
    });
  }
  return queueTimingAuditTableReady;
}

export async function recordQueueTimingChange(
  data: InsertQueueTimingAudit,
): Promise<QueueTimingAudit> {
  await ensureQueueTimingAuditTable();
  const [row] = await getDb().insert(queueTimingAudit).values(data).returning();
  return row;
}

export async function listQueueTimingAudit(limit = 10): Promise<QueueTimingAudit[]> {
  await ensureQueueTimingAuditTable();
  return getDb().select().from(queueTimingAudit)
    .orderBy(desc(queueTimingAudit.changedAt))
    .limit(limit);
}

export async function pruneQueueTimingAudit(opts: {
  maxEntries?: number;
  maxAgeDays?: number;
}): Promise<number> {
  await ensureQueueTimingAuditTable();
  let pruned = 0;

  if (opts.maxAgeDays !== undefined && opts.maxAgeDays > 0) {
    const days = Math.floor(opts.maxAgeDays);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const deleted = await getDb()
      .delete(queueTimingAudit)
      .where(lt(queueTimingAudit.changedAt, cutoff))
      .returning({ id: queueTimingAudit.id });
    pruned += deleted.length;
  }

  if (opts.maxEntries !== undefined && opts.maxEntries > 0) {
    const keep = Math.floor(opts.maxEntries);
    const survivors = await getDb()
      .select({ id: queueTimingAudit.id })
      .from(queueTimingAudit)
      .orderBy(desc(queueTimingAudit.changedAt))
      .limit(keep);
    const keepIds = survivors.map((row) => row.id);
    const deleted = keepIds.length > 0
      ? await getDb()
          .delete(queueTimingAudit)
          .where(notInArray(queueTimingAudit.id, keepIds))
          .returning({ id: queueTimingAudit.id })
      : await getDb()
          .delete(queueTimingAudit)
          .returning({ id: queueTimingAudit.id });
    pruned += deleted.length;
  }

  return pruned;
}

/**
 * Read-only estimate of how many `queue_timing_audit` rows would be removed
 * by the next prune given the supplied bounds. Performs no writes.
 *
 * Mirrors `pruneQueueTimingAudit` semantics — see
 * `estimatePruneStaleLeaseThresholdAudit` for details.
 */
export async function estimatePruneQueueTimingAudit(opts: {
  maxEntries?: number;
  maxAgeDays?: number;
}): Promise<{ wouldRemove: number; total: number }> {
  await ensureQueueTimingAuditTable();
  const totalRows = await getDb()
    .execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM ${queueTimingAudit}`);
  const total = Number(totalRows.rows?.[0]?.count ?? 0);

  const hasAge = opts.maxAgeDays !== undefined && opts.maxAgeDays > 0;
  const hasEntries = opts.maxEntries !== undefined && opts.maxEntries > 0;
  if (!hasAge && !hasEntries) return { wouldRemove: 0, total };

  const cutoff = hasAge
    ? new Date(Date.now() - Math.floor(opts.maxAgeDays!) * 24 * 60 * 60 * 1000)
    : null;
  const keep = hasEntries ? Math.floor(opts.maxEntries!) : 0;

  const ageCond = hasAge ? sql`changed_at < ${cutoff}` : sql`false`;
  const entriesCond = hasEntries ? sql`rn > ${keep}` : sql`false`;

  const result = await getDb().execute<{ count: string }>(sql`
    WITH ranked AS (
      SELECT id, changed_at,
        row_number() OVER (ORDER BY changed_at DESC, id DESC) AS rn
      FROM ${queueTimingAudit}
    )
    SELECT count(*)::text AS count FROM ranked
    WHERE (${ageCond}) OR (${entriesCond})
  `);
  const wouldRemove = Number(result.rows?.[0]?.count ?? 0);
  return { wouldRemove, total };
}

let adminSettingAuditTableReady: Promise<void> | null = null;

export async function ensureAdminSettingAuditTable(): Promise<void> {
  if (!adminSettingAuditTableReady) {
    adminSettingAuditTableReady = (async () => {
      await getDb().execute(sql`
        CREATE TABLE IF NOT EXISTS "admin_setting_audit" (
          "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
          "setting_key" varchar(128) NOT NULL,
          "scope" varchar(128),
          "changed_by" varchar REFERENCES users(id),
          "old_values" jsonb,
          "new_values" jsonb,
          "changed_at" timestamp NOT NULL DEFAULT now()
        )
      `);
      await getDb().execute(sql`
        CREATE INDEX IF NOT EXISTS "admin_setting_audit_key_time_idx"
          ON "admin_setting_audit" ("setting_key", "changed_at" DESC)
      `);
      await getDb().execute(sql`
        CREATE INDEX IF NOT EXISTS "admin_setting_audit_key_scope_time_idx"
          ON "admin_setting_audit" ("setting_key", "scope", "changed_at" DESC)
      `);
      await getDb().execute(sql`
        ALTER TABLE "admin_setting_audit"
          ADD COLUMN IF NOT EXISTS "slack_status" varchar,
          ADD COLUMN IF NOT EXISTS "email_status" varchar,
          ADD COLUMN IF NOT EXISTS "slack_failure_reason" text,
          ADD COLUMN IF NOT EXISTS "email_failure_reason" text,
          ADD COLUMN IF NOT EXISTS "last_resend_at" timestamp,
          ADD COLUMN IF NOT EXISTS "last_resend_by" varchar REFERENCES users(id),
          ADD COLUMN IF NOT EXISTS "last_resend_source" varchar
      `);
    })().catch((err) => {
      adminSettingAuditTableReady = null;
      throw err;
    });
  }
  return adminSettingAuditTableReady;
}

export async function recordAdminSettingChange(
  data: InsertAdminSettingAudit,
): Promise<AdminSettingAudit> {
  await ensureAdminSettingAuditTable();
  const [row] = await getDb().insert(adminSettingAudit).values(data).returning();
  return row;
}

export async function getAdminSettingAuditById(
  id: string,
): Promise<AdminSettingAudit | undefined> {
  await ensureAdminSettingAuditTable();
  const [row] = await getDb().select().from(adminSettingAudit).where(eq(adminSettingAudit.id, id));
  return row;
}

export async function updateAdminSettingAuditDelivery(params: {
  id: string;
  slackStatus?: string | null;
  emailStatus?: string | null;
  slackFailureReason?: string | null;
  emailFailureReason?: string | null;
  lastResendAt?: Date | null;
  lastResendBy?: string | null;
  lastResendSource?: string | null;
}): Promise<void> {
  await ensureAdminSettingAuditTable();
  const patch: Record<string, string | Date | null> = {};
  if (params.slackStatus !== undefined) patch.slackStatus = params.slackStatus;
  if (params.emailStatus !== undefined) patch.emailStatus = params.emailStatus;
  if (params.slackFailureReason !== undefined) patch.slackFailureReason = params.slackFailureReason;
  if (params.emailFailureReason !== undefined) patch.emailFailureReason = params.emailFailureReason;
  if (params.lastResendAt !== undefined) patch.lastResendAt = params.lastResendAt;
  if (params.lastResendBy !== undefined) patch.lastResendBy = params.lastResendBy;
  if (params.lastResendSource !== undefined) patch.lastResendSource = params.lastResendSource;
  if (Object.keys(patch).length === 0) return;
  await getDb()
    .update(adminSettingAudit)
    .set(patch)
    .where(eq(adminSettingAudit.id, params.id));
}

export async function listAdminSettingAudit(opts: {
  settingKey: string;
  scope?: string;
  changedByIn?: string[];
  changedAfter?: Date;
  changedBefore?: Date;
  limit?: number;
}): Promise<AdminSettingAudit[]> {
  await ensureAdminSettingAuditTable();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const conds = [eq(adminSettingAudit.settingKey, opts.settingKey)];
  if (opts.scope !== undefined) {
    conds.push(eq(adminSettingAudit.scope, opts.scope));
  }
  if (opts.changedByIn !== undefined) {
    if (opts.changedByIn.length === 0) return [];
    conds.push(inArray(adminSettingAudit.changedBy, opts.changedByIn));
  }
  if (opts.changedAfter) {
    conds.push(sql`${adminSettingAudit.changedAt} >= ${opts.changedAfter}`);
  }
  if (opts.changedBefore) {
    conds.push(sql`${adminSettingAudit.changedAt} <= ${opts.changedBefore}`);
  }
  return getDb().select().from(adminSettingAudit)
    .where(conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(adminSettingAudit.changedAt))
    .limit(limit);
}

/**
 * Prune `admin_setting_audit` rows for a given setting key so that each scope
 * (e.g. each IP under `setting_key = "blocked_ip"`) keeps only the N most
 * recent entries. Rows with NULL scope are treated as a single bucket.
 *
 * If `scope` is provided, only that scope is pruned; otherwise every scope
 * for the setting key is pruned in a single statement.
 */
export interface PrunePerScopeResult {
  scope: string | null;
  count: number;
}

export async function pruneAdminSettingAuditPerScopeReturning(opts: {
  settingKey: string;
  maxEntriesPerScope: number;
  scope?: string;
}): Promise<PrunePerScopeResult[]> {
  await ensureAdminSettingAuditTable();
  const keep = Math.max(1, Math.floor(opts.maxEntriesPerScope));
  const scopeFilter = opts.scope !== undefined
    ? sql`AND coalesce(scope, '') = ${opts.scope}`
    : sql``;
  const result = await getDb().execute<{ scope: string | null }>(sql`
    DELETE FROM admin_setting_audit
    WHERE id IN (
      SELECT id FROM (
        SELECT id, scope,
          row_number() OVER (
            PARTITION BY coalesce(scope, '')
            ORDER BY changed_at DESC, id DESC
          ) AS rn
        FROM admin_setting_audit
        WHERE setting_key = ${opts.settingKey}
        ${scopeFilter}
      ) t
      WHERE t.rn > ${keep}
    )
    RETURNING scope
  `);
  const counts = new Map<string | null, number>();
  for (const row of result.rows) {
    const key = row.scope ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([scope, count]) => ({ scope, count }));
}

export async function pruneAdminSettingAuditPerScope(opts: {
  settingKey: string;
  maxEntriesPerScope: number;
  scope?: string;
}): Promise<number> {
  await ensureAdminSettingAuditTable();
  const keep = Math.max(1, Math.floor(opts.maxEntriesPerScope));
  const scopeFilter = opts.scope !== undefined
    ? sql`AND coalesce(scope, '') = ${opts.scope}`
    : sql``;
  const result = await getDb().execute<{ id: string }>(sql`
    DELETE FROM admin_setting_audit
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          row_number() OVER (
            PARTITION BY coalesce(scope, '')
            ORDER BY changed_at DESC, id DESC
          ) AS rn
        FROM admin_setting_audit
        WHERE setting_key = ${opts.settingKey}
        ${scopeFilter}
      ) t
      WHERE t.rn > ${keep}
    )
    RETURNING id
  `);
  return result.rows.length;
}
