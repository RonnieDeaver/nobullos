/**
 * Integrations routes — shared helpers (Task #4152 / F6 split).
 * `buildRecoverySettingHistory` was declared inside registerIntegrationRoutes
 * in server/routes/integrations.ts (lines 3703–3722) and is used by BOTH the
 * front historical-recovery settings routes and the work-queue retention
 * routes, so it lives in this leaf module. Body is verbatim apart from the
 * `export` prefix and dynamic-import specifier depth (./ -> ../).
 */
import { storage } from "../../storage";

export async function buildRecoverySettingHistory(settingKey: string, limit: number) {
    const entries = await storage.listAdminSettingAudit({ settingKey, limit });
    const { resolveLastEditedUsers } = await import("../lastEditedHelper");
    const userMap = await resolveLastEditedUsers(entries.map((e) => e.changedBy));
    return entries.map((e) => {
      const u = e.changedBy ? userMap.get(e.changedBy) ?? null : null;
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id
        : null;
      return {
        id: e.id,
        changedBy: e.changedBy ?? null,
        changedByName: name,
        changedByEmail: u?.email ?? null,
        oldValues: e.oldValues ?? null,
        newValues: e.newValues ?? null,
        changedAt: e.changedAt instanceof Date ? e.changedAt.toISOString() : (e.changedAt as any),
      };
    });
  }
