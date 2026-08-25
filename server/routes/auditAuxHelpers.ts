import { inArray } from "drizzle-orm";
import { db } from "../db";

function isValidIPv4(ip: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(ip);
}

function isValidIPv6(ip: string): boolean {
  return /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::)$/.test(ip);
}

export function isValidIpOrCidr(value: string): boolean {
  if (!value) return false;
  const slash = value.indexOf("/");
  if (slash === -1) {
    return isValidIPv4(value) || isValidIPv6(value);
  }
  const addr = value.slice(0, slash);
  const bitsStr = value.slice(slash + 1);
  if (!/^\d+$/.test(bitsStr)) return false;
  const bits = Number(bitsStr);
  if (isValidIPv4(addr)) return bits >= 0 && bits <= 32;
  if (isValidIPv6(addr)) return bits >= 0 && bits <= 128;
  return false;
}

export type AdminAuditEntry = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  oldValues: unknown;
  newValues: unknown;
  changedAt: Date | string | null;
};

export async function attachUserInfoToAudit<T extends AdminAuditEntry>(
  entries: T[],
): Promise<Array<T & { changedByName: string | null; changedByEmail: string | null }>> {
  const userIds = Array.from(new Set(entries.map((e) => e.changedBy).filter((id): id is string => !!id)));
  const userMap = new Map<string, { id: string; firstName: string | null; lastName: string | null; email: string | null }>();
  if (userIds.length > 0) {
    const { users } = await import("@shared/schema");
    const rows = await db.select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    }).from(users).where(inArray(users.id, userIds));
    for (const u of rows) userMap.set(u.id, u);
  }
  return entries.map((e) => {
    const u = e.changedBy ? userMap.get(e.changedBy) : null;
    const name = u
      ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id
      : null;
    return {
      ...e,
      changedByName: name,
      changedByEmail: u?.email ?? null,
    };
  });
}
