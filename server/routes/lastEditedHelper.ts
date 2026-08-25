import { db } from "../db";
import { users, adminSettingAudit } from "@shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export type LastEditedUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

export type LastEditedInfo = {
  updatedAt: string | null;
  updatedBy: LastEditedUser | null;
};

export async function resolveLastEditedUsers(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, LastEditedUser>> {
  const map = new Map<string, LastEditedUser>();
  const ids = Array.from(
    new Set(userIds.filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      firstName: r.firstName ?? null,
      lastName: r.lastName ?? null,
      email: r.email ?? null,
    });
  }
  return map;
}

export async function getLastEditedFromAudit(opts: {
  settingKey: string;
  scopes?: Array<string | null>;
}): Promise<Map<string, LastEditedInfo>> {
  const result = new Map<string, LastEditedInfo>();
  try {
    const { ensureAdminSettingAuditTable } = await import("../storage/settingsStorage");
    await ensureAdminSettingAuditTable();
  } catch {
    return result;
  }

  const { settingKey, scopes } = opts;
  type Row = { scope: string | null; updatedAt: Date | null; updatedBy: string | null };
  const rows: Row[] = [];

  if (scopes && scopes.length > 0) {
    for (const scope of scopes) {
      const where = scope === null
        ? and(eq(adminSettingAudit.settingKey, settingKey), sql`${adminSettingAudit.scope} IS NULL`)
        : and(eq(adminSettingAudit.settingKey, settingKey), eq(adminSettingAudit.scope, scope));
      const [latest] = await db
        .select({
          scope: adminSettingAudit.scope,
          updatedAt: adminSettingAudit.changedAt,
          updatedBy: adminSettingAudit.changedBy,
        })
        .from(adminSettingAudit)
        .where(where)
        .orderBy(desc(adminSettingAudit.changedAt))
        .limit(1);
      if (latest) rows.push(latest);
    }
  } else {
    const all = await db
      .select({
        scope: adminSettingAudit.scope,
        updatedAt: adminSettingAudit.changedAt,
        updatedBy: adminSettingAudit.changedBy,
      })
      .from(adminSettingAudit)
      .where(eq(adminSettingAudit.settingKey, settingKey))
      .orderBy(desc(adminSettingAudit.changedAt));
    const seen = new Set<string>();
    for (const r of all) {
      const k = r.scope ?? "__null__";
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(r);
    }
  }

  const userMap = await resolveLastEditedUsers(rows.map((r) => r.updatedBy));
  for (const r of rows) {
    const key = r.scope ?? "__null__";
    result.set(key, buildLastEdited(r.updatedAt, r.updatedBy, userMap));
  }
  return result;
}

export function buildLastEdited(
  updatedAt: Date | string | null | undefined,
  updatedBy: string | null | undefined,
  userMap: Map<string, LastEditedUser>,
): LastEditedInfo {
  const at = updatedAt instanceof Date
    ? updatedAt.toISOString()
    : (typeof updatedAt === "string" ? updatedAt : null);
  const user = updatedBy ? userMap.get(updatedBy) ?? null : null;
  return { updatedAt: at, updatedBy: user };
}
