// @db-pool-intent: worker
/**
 * Task #2984 — ClickUp auth breaker persistence.
 *
 * Registers trip/clear hooks with clickUpClient.ts so that a tripped
 * per-user auth breaker survives process restart (cross-instance) by
 * persisting to system_settings (key: `clickup_auth_breaker_<tokenKey>`).
 *
 * Lifecycle:
 *  1. Boot: hydrateClickUpAuthBreakers() reads all clickup_auth_breaker_*
 *     settings and loads still-live entries into the in-memory map.
 *  2. Trip (new streak only): persist JSON blob to system_settings + fire
 *     a once-per-streak admin alert via notifyByType (deduped per tokenKey).
 *  3. Clear: delete the system_settings row (raw SQL to avoid needing a
 *     dedicated storage interface method).
 *
 * The 10-minute auto-clear TTL is enforced in-memory by clickUpClient.ts;
 * persisted entries that outlive the TTL are harmlessly skipped at hydration.
 */

import { registerClickUpBreakerPersistenceHooks, loadClickUpBreakerState } from "./clickUpClient";
import { setSystemSetting } from "../storage/settingsStorage";

const SETTING_PREFIX = "clickup_auth_breaker_";
const BREAKER_TTL_MS = 10 * 60 * 1000;

/**
 * Called once at boot (server/index.ts) before the work-queue scheduler
 * starts. Reads all persisted clickup_auth_breaker_* settings and restores
 * any that are still within the 10-minute TTL into the in-memory map.
 */
export async function hydrateClickUpAuthBreakers(): Promise<void> {
  try {
    const { getDb, withDbAttribution } = await import("../db");
    const rows = await withDbAttribution("clickup:breakerHydrate", async () => {
      const db = getDb();
      const result = await db.execute(
        `SELECT key, value FROM system_settings WHERE key LIKE '${SETTING_PREFIX}%'` as any,
      );
      return (result.rows ?? []) as Array<{ key: string; value: string }>;
    });

    const now = Date.now();
    const entries: Array<{ tokenKey: string; since: number; reason: string }> = [];
    for (const row of rows) {
      try {
        const tokenKey = row.key.slice(SETTING_PREFIX.length);
        const data = JSON.parse(row.value);
        if (typeof data.since === "number" && !data.cleared && now - data.since < BREAKER_TTL_MS) {
          entries.push({
            tokenKey,
            since: data.since,
            reason: typeof data.reason === "string" ? data.reason : "persisted",
          });
        }
      } catch {
        // ignore malformed entries
      }
    }

    if (entries.length > 0) {
      loadClickUpBreakerState(entries);
      console.log(`[ClickUpBreaker] Hydrated ${entries.length} auth breaker(s) at boot`);
    }
  } catch (err: any) {
    console.warn("[ClickUpBreaker] Boot hydration failed (proceeding with empty state):", err?.message);
  }
}

registerClickUpBreakerPersistenceHooks({
  onTrip: (tokenKey: string, reason: string) => {
    void (async () => {
      try {
        await setSystemSetting(
          `${SETTING_PREFIX}${tokenKey}`,
          JSON.stringify({ since: Date.now(), reason }),
          "system",
        );
      } catch (err: any) {
        console.warn(`[ClickUpBreaker] Failed to persist trip for tokenKey=${tokenKey}:`, err?.message);
      }
      try {
        const { notifyByType } = await import("./notifications/dispatcher");
        await notifyByType(
          "integration.clickup.auth_dead",
          {
            text:
              `*ClickUp auth breaker opened* — a user token appears revoked or invalid ` +
              `(token suffix: \`${tokenKey}\`). Re-authorize ClickUp in Settings → Integrations Hub.`,
          },
          {
            triggerSource: "alert_service",
            dedupeKey: `clickup.auth_dead.${tokenKey}`,
          },
        );
      } catch (alertErr: any) {
        console.warn("[ClickUpBreaker] Failed to send auth-dead alert:", alertErr?.message);
      }
    })();
  },
  onClear: (tokenKey: string) => {
    void (async () => {
      try {
        const { getDb, withDbAttribution } = await import("../db");
        await withDbAttribution("clickup:breakerClear", async () => {
          const { sql } = await import("drizzle-orm");
          const db = getDb();
          await db.execute(sql`DELETE FROM system_settings WHERE key = ${SETTING_PREFIX + tokenKey}`);
        });
      } catch (err: any) {
        console.warn(`[ClickUpBreaker] Failed to clear persisted breaker for tokenKey=${tokenKey}:`, err?.message);
      }
    })();
  },
});
