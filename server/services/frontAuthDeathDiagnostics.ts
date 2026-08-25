// Task #2142 — durable Front auth-death diagnostics.
//
// The Front auth-dead circuit breaker (`frontAuthBreaker.ts`) trips when
// Front's OAuth refresh token is terminally rejected and surfaces *that*
// it died (open/closed, last-tripped-at, trip count) on the Integrations
// Hub badge. It does not, however, capture *why* the last death happened:
// the HTTP status Front returned, the response body snippet, which
// environment it died in, or when Front auth last worked. That context is
// exactly what an operator needs to confirm a reconnect actually fixed the
// problem rather than re-arming the same broken credential.
//
// This module persists a small, read-only diagnostic trail to
// `system_settings`:
//   - `front_auth_death:last`   — the most recent death record (single JSON)
//   - `front_auth_death:recent` — a capped ring of the most recent deaths
//
// `recordFrontAuthDeath` is called from the terminal-auth catch path in
// `frontIntegration.ts` (the same site that trips the breaker). It is
// fire-and-forget and never throws, so a DB / cache hiccup can never break
// the synchronous token-acquisition path. `getLastFrontAuthDeath` /
// `getRecentFrontAuthDeaths` are the read helpers the Integrations-Hub
// route consumes.

import { getSystemSetting, setSystemSetting } from "../storage/settingsStorage";

export const FRONT_AUTH_DEATH_LAST_KEY = "front_auth_death:last";
export const FRONT_AUTH_DEATH_RECENT_KEY = "front_auth_death:recent";

/** How many recent deaths the ring keeps. */
const RECENT_CAP = 10;
/** Longest a persisted body snippet is allowed to be. */
const SNIPPET_MAX = 500;
/**
 * Collapse a burst of identical terminal failures into one record. At the
 * instant the breaker trips, several concurrent token acquisitions can all
 * reach the catch path with the same code; without this the ring fills with
 * duplicates of one outage instead of being a meaningful timeline.
 */
const DEDUP_WINDOW_MS = 60_000;

export interface FrontAuthDeathRecord {
  /** Terminal Front auth code, e.g. `front_refresh_failed_permanent`. */
  code: string;
  /** HTTP status Front returned on the refresh, when known. */
  httpStatus: number | null;
  /** Trimmed response-body / error-message snippet (capped). */
  bodySnippet: string | null;
  /** `production` | `development` — which runtime the death happened in. */
  environment: string;
  /** ISO timestamp of the last successful Front call before this death. */
  lastSuccessAt: string | null;
  /** ISO timestamp the death was recorded. */
  diedAt: string;
  /**
   * Task #2435 — ISO timestamp Front auth was observed healthy again
   * (successful token persist after a refresh/connect, or a 2xx `/me`
   * probe) AFTER this death was recorded. `null` while the death is still
   * unrecovered. A one-second refresh-token rotation-race blip self-heals
   * almost immediately and gets annotated here so the Integrations-Hub
   * panel renders it as healed instead of a permanent red failure; a
   * genuine outage that stays dead never gets a `recoveredAt`.
   */
  recoveredAt?: string | null;
}

let lastRecordedAtMs = 0;
let lastRecordedCode: string | null = null;
/**
 * Task #2435 — in-process short-circuit for `markFrontAuthDeathRecovered`.
 * Recovery signals (a successful background refresh, an operator reconnect,
 * every healthy `/me` probe) fire often while Front is healthy; once we've
 * confirmed there is no unrecovered death to annotate we skip the DB read
 * on every subsequent signal until a NEW death is recorded. `recordFront-
 * AuthDeath` clears it so the next recovery re-annotates.
 */
let noUnrecoveredDeathToAnnotate = false;

function currentEnvironment(): string {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

function clampSnippet(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > SNIPPET_MAX ? `${trimmed.slice(0, SNIPPET_MAX)}…` : trimmed;
}

/** Defensively coerce an unknown parsed value into a record (or null). */
function normalizeRecord(value: unknown): FrontAuthDeathRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string" || typeof v.diedAt !== "string") return null;
  return {
    code: v.code,
    httpStatus:
      typeof v.httpStatus === "number" && Number.isFinite(v.httpStatus)
        ? v.httpStatus
        : null,
    bodySnippet: typeof v.bodySnippet === "string" ? v.bodySnippet : null,
    environment: typeof v.environment === "string" ? v.environment : "unknown",
    lastSuccessAt: typeof v.lastSuccessAt === "string" ? v.lastSuccessAt : null,
    diedAt: v.diedAt,
    recoveredAt: typeof v.recoveredAt === "string" ? v.recoveredAt : null,
  };
}

/**
 * Record a terminal Front auth death. Fire-and-forget and exception-safe —
 * the caller is a synchronous token-acquisition catch path that must never
 * be broken by a persistence failure.
 */
export async function recordFrontAuthDeath(input: {
  code: string;
  httpStatus?: number | null;
  bodySnippet?: string | null;
  lastSuccessAt?: string | null;
}): Promise<void> {
  const now = Date.now();
  // In-process dedup of a concurrent burst (see DEDUP_WINDOW_MS).
  if (lastRecordedCode === input.code && now - lastRecordedAtMs < DEDUP_WINDOW_MS) {
    return;
  }
  lastRecordedAtMs = now;
  lastRecordedCode = input.code;
  // Task #2435 — a fresh death must be eligible for a recovery annotation
  // again, even if a prior death had already been annotated/short-circuited.
  noUnrecoveredDeathToAnnotate = false;

  const record: FrontAuthDeathRecord = {
    code: input.code,
    httpStatus: input.httpStatus ?? null,
    bodySnippet: clampSnippet(input.bodySnippet),
    environment: currentEnvironment(),
    lastSuccessAt: input.lastSuccessAt ?? null,
    diedAt: new Date(now).toISOString(),
  };

  try {
    await setSystemSetting(FRONT_AUTH_DEATH_LAST_KEY, JSON.stringify(record), "system");
  } catch (err: any) {
    console.error("[Front] auth-death :last persist failed:", err?.message ?? err);
  }

  try {
    const recent = await getRecentFrontAuthDeaths();
    const next = [record, ...recent].slice(0, RECENT_CAP);
    await setSystemSetting(FRONT_AUTH_DEATH_RECENT_KEY, JSON.stringify(next), "system");
  } catch (err: any) {
    console.error("[Front] auth-death :recent persist failed:", err?.message ?? err);
  }
}

/** The most recent Front auth death, or null if Front has never died. */
export async function getLastFrontAuthDeath(): Promise<FrontAuthDeathRecord | null> {
  try {
    const raw = (await getSystemSetting(FRONT_AUTH_DEATH_LAST_KEY))?.value;
    if (!raw) return null;
    return normalizeRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The capped ring of recent Front auth deaths, newest first. */
export async function getRecentFrontAuthDeaths(): Promise<FrontAuthDeathRecord[]> {
  try {
    const raw = (await getSystemSetting(FRONT_AUTH_DEATH_RECENT_KEY))?.value;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeRecord)
      .filter((r): r is FrontAuthDeathRecord => r !== null);
  } catch {
    return [];
  }
}

/**
 * Task #2435 — annotate the most recent Front auth death as recovered.
 *
 * Called from the genuine Front-auth recovery sites (a successful token
 * persist after a refresh/connect, and a 2xx `/me` probe) so the durable
 * death diagnostics distinguish a healed login-race blip from a permanent
 * outage. Fire-and-forget and exception-safe — recovery must never be
 * broken by a persistence failure. Idempotent: a death already carrying a
 * `recoveredAt` (or no death on record) is left untouched, and an
 * in-process short-circuit avoids the DB read on the steady stream of
 * recovery signals Front emits while healthy.
 *
 * NOTE: this only annotates an existing death; it never invents one. A
 * true revocation that never recovers simply never gets a `recoveredAt`,
 * so this cannot mask a real outage.
 */
export async function markFrontAuthDeathRecovered(): Promise<void> {
  if (noUnrecoveredDeathToAnnotate) return;
  const recoveredAt = new Date().toISOString();
  try {
    const last = await getLastFrontAuthDeath();
    if (!last || last.recoveredAt) {
      // Nothing to annotate (no death, or already annotated). Skip the DB
      // read on subsequent recovery signals until the next death resets it.
      noUnrecoveredDeathToAnnotate = true;
      return;
    }

    const annotatedLast: FrontAuthDeathRecord = { ...last, recoveredAt };
    try {
      await setSystemSetting(
        FRONT_AUTH_DEATH_LAST_KEY,
        JSON.stringify(annotatedLast),
        "system",
      );
    } catch (err: any) {
      console.error("[Front] auth-death :last recovery annotate failed:", err?.message ?? err);
    }

    // Patch the matching newest-first entry in the recent ring (by diedAt +
    // code) so the timeline shows the same healed state the badge does.
    try {
      const recent = await getRecentFrontAuthDeaths();
      let changed = false;
      const next = recent.map((r) => {
        if (!r.recoveredAt && r.diedAt === last.diedAt && r.code === last.code) {
          changed = true;
          return { ...r, recoveredAt };
        }
        return r;
      });
      if (changed) {
        await setSystemSetting(
          FRONT_AUTH_DEATH_RECENT_KEY,
          JSON.stringify(next),
          "system",
        );
      }
    } catch (err: any) {
      console.error("[Front] auth-death :recent recovery annotate failed:", err?.message ?? err);
    }

    noUnrecoveredDeathToAnnotate = true;
  } catch (err: any) {
    console.error("[Front] auth-death recovery annotate failed:", err?.message ?? err);
  }
}

/** Test-only: clear the in-process dedup guard between cases. */
export function __resetFrontAuthDeathDedupForTest(): void {
  lastRecordedAtMs = 0;
  lastRecordedCode = null;
  noUnrecoveredDeathToAnnotate = false;
}
