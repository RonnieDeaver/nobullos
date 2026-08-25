// @db-pool-intent: ambient
//
// Sheets storage module — CRUD for sheet_folders, sheet_workbooks,
// sheet_workbook_permissions, sheet_workbook_locks (edit-locking),
// sheet_data_blocks, sheet_templates, sheet_workbook_role_grants, and sheet_workbook_versions.
// Callers on the api pool (request-scoped) and the worker pool (background)
// both route through getDb().

import {
  sheetFolders,
  sheetWorkbooks,
  sheetWorkbookPermissions,
  sheetWorkbookLocks,
  sheetDataBlocks,
  sheetTemplates,
  sheetWorkbookRoleGrants,
  sheetWorkbookVersions,
  sheetWorkbookActivity,
  type SheetFolder,
  type InsertSheetFolder,
  type SheetWorkbook,
  type InsertSheetWorkbook,
  type SheetWorkbookPermission,
  type InsertSheetWorkbookPermission,
  type SheetWorkbookLock,
  type SheetDataBlock,
  type InsertSheetDataBlock,
  type SheetTemplate,
  type InsertSheetTemplate,
  type SheetWorkbookRoleGrant,
  type InsertSheetWorkbookRoleGrant,
  type SheetWorkbookVersion,
  type InsertSheetWorkbookVersion,
  type SheetWorkbookVersionMeta,
  type SheetWorkbookActivity,
  type SheetActivityAction,
} from "@shared/schema";

import { getDb, withDbAttribution } from "../db";
import { bindArrayParam } from "../utils/sqlArray";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

/**
 * Workbook record with the heavy `snapshot` JSONB column excluded.
 * Used by list/library endpoints so the query doesn't transfer large
 * snapshot blobs for every row.
 */
export type SheetWorkbookMeta = Omit<SheetWorkbook, "snapshot">;

// Lock TTL: 90 seconds. Client heartbeats every 30 s, so 3 misses = expired.
const LOCK_TTL_MS = 90_000;

// ---- Ensure sheet_data_blocks table ----
// The table is defined in Drizzle schema but in case the deploy-time push
// hasn't run yet (e.g. dev env without a fresh migration), we create it
// idempotently on first use.

let dataBlocksTableEnsured = false;

export async function ensureSheetDataBlocksTable(): Promise<void> {
  if (dataBlocksTableEnsured) return;
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sheet_data_blocks (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      workbook_id varchar NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
      sheet_id text NOT NULL,
      label text NOT NULL,
      connector_id varchar NOT NULL,
      connector_params jsonb NOT NULL DEFAULT '{}'::jsonb,
      start_row integer NOT NULL DEFAULT 0,
      start_col integer NOT NULL DEFAULT 0,
      row_count integer NOT NULL DEFAULT 1,
      col_count integer NOT NULL DEFAULT 1,
      auto_refresh boolean NOT NULL DEFAULT false,
      last_refreshed_at timestamp,
      created_by varchar REFERENCES users(id),
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sheet_data_blocks_workbook_id_idx
      ON sheet_data_blocks (workbook_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sheet_data_blocks_auto_refresh_idx
      ON sheet_data_blocks (auto_refresh)
  `);
  dataBlocksTableEnsured = true;
}

// ---- sheet_folders ----

export async function getSheetFolder(id: string): Promise<SheetFolder | undefined> {
  const [row] = await getDb().select().from(sheetFolders).where(eq(sheetFolders.id, id));
  return row;
}

export async function listSheetFolders(ownerId: string): Promise<SheetFolder[]> {
  return getDb().select().from(sheetFolders).where(eq(sheetFolders.ownerId, ownerId));
}

export async function createSheetFolder(data: InsertSheetFolder): Promise<SheetFolder> {
  const [row] = await getDb().insert(sheetFolders).values(data).returning();
  return row;
}

export async function updateSheetFolder(
  id: string,
  data: Partial<Pick<InsertSheetFolder, "name">>,
): Promise<SheetFolder | undefined> {
  const [row] = await getDb()
    .update(sheetFolders)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sheetFolders.id, id))
    .returning();
  return row;
}

export async function deleteSheetFolder(id: string): Promise<void> {
  await getDb().delete(sheetFolders).where(eq(sheetFolders.id, id));
}

// ---- sheet_workbooks ----

export async function getSheetWorkbook(id: string): Promise<SheetWorkbook | undefined> {
  const [row] = await getDb().select().from(sheetWorkbooks).where(eq(sheetWorkbooks.id, id));
  return row;
}

export type SheetWorkbookSortKey =
  | "name"
  | "folder"
  | "owner"
  | "updated"
  | "activity";

export interface ListSheetWorkbooksFilters {
  userId: string;
  userRole?: string;
  /** `null` = unfiled (no folder, or folder no longer exists). */
  folderId?: string | null;
  /** Case-insensitive name substring filter (LIKE wildcards escaped). */
  q?: string;
  sort?: SheetWorkbookSortKey;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Escape LIKE wildcards in user input for ILIKE substring matching. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * List workbooks accessible to `userId` with the total matching count,
 * returning ONLY metadata columns (no `snapshot` JSONB). This keeps the
 * library query fast even when individual workbooks hold multi-MB
 * snapshots, and (Task #4488) lets the library paginate server-side.
 */
export async function listSheetWorkbooksPage(
  filters: ListSheetWorkbooksFilters,
): Promise<{ workbooks: SheetWorkbookMeta[]; total: number }> {
  const { isNull } = await import("drizzle-orm");
  const db = getDb();

  const conds: any[] = [];

  // Visibility: CEO sees all workbooks; everyone else sees owned +
  // per-user-granted + role-granted workbooks.
  if (filters.userRole !== "ceo") {
    // Build set of workbook IDs from user-level permission grants.
    const permittedIds = await db
      .select({ workbookId: sheetWorkbookPermissions.workbookId })
      .from(sheetWorkbookPermissions)
      .where(eq(sheetWorkbookPermissions.userId, filters.userId));

    const permittedSet = permittedIds.map((r) => r.workbookId);

    // Build set from role-level grants.
    let roleGrantedSet: string[] = [];
    if (filters.userRole) {
      const roleGrants = await db
        .select({ workbookId: sheetWorkbookRoleGrants.workbookId })
        .from(sheetWorkbookRoleGrants)
        .where(eq(sheetWorkbookRoleGrants.role, filters.userRole));
      roleGrantedSet = roleGrants.map((r) => r.workbookId);
    }

    const allGrantedIds = [...new Set([...permittedSet, ...roleGrantedSet])];

    conds.push(
      or(
        eq(sheetWorkbooks.ownerId, filters.userId),
        allGrantedIds.length > 0
          ? inArray(sheetWorkbooks.id, allGrantedIds)
          : undefined,
      ),
    );
  }

  if (filters.folderId !== undefined) {
    if (filters.folderId === null) {
      // "Unfiled" includes rows whose folder was deleted (dangling id) —
      // same self-healing the library UI applied client-side before #4488.
      conds.push(
        or(
          isNull(sheetWorkbooks.folderId),
          sql`NOT EXISTS (SELECT 1 FROM sheet_folders sf WHERE sf.id = ${sheetWorkbooks.folderId})`,
        ),
      );
    } else {
      conds.push(eq(sheetWorkbooks.folderId, filters.folderId));
    }
  }

  if (filters.q && filters.q.trim()) {
    conds.push(
      sql`${sheetWorkbooks.name} ILIKE ${"%" + escapeLike(filters.q.trim()) + "%"}`,
    );
  }

  const where = conds.length > 0 ? and(...(conds as any[])) : undefined;

  // Order: deterministic across pages. NULLS LAST mirrors the previous
  // client-side sort (rows without a folder/activity always sink).
  const d = sql.raw(filters.dir === "asc" ? "asc" : "desc");
  let orderExpr;
  switch (filters.sort) {
    case "name":
      orderExpr = sql`lower(${sheetWorkbooks.name}) ${d}`;
      break;
    case "folder":
      orderExpr = sql`(SELECT lower(sf.name) FROM sheet_folders sf WHERE sf.id = ${sheetWorkbooks.folderId}) ${d} NULLS LAST`;
      break;
    case "owner":
      orderExpr = sql`(${sheetWorkbooks.ownerId} = ${filters.userId}) ${d}`;
      break;
    case "activity":
      await ensureSheetActivityTable();
      orderExpr = sql`(SELECT max(a.created_at) FROM sheet_workbook_activity a WHERE a.workbook_id = ${sheetWorkbooks.id}) ${d} NULLS LAST`;
      break;
    case "updated":
    default:
      orderExpr = sql`${sheetWorkbooks.updatedAt} ${d}`;
      break;
  }

  // Explicitly select every column EXCEPT snapshot so we never transfer
  // large JSONB blobs on the library list query.
  let query = db
    .select({
      id: sheetWorkbooks.id,
      name: sheetWorkbooks.name,
      folderId: sheetWorkbooks.folderId,
      ownerId: sheetWorkbooks.ownerId,
      snapshotSizeBytes: sheetWorkbooks.snapshotSizeBytes,
      revision: sheetWorkbooks.revision,
      createdAt: sheetWorkbooks.createdAt,
      updatedAt: sheetWorkbooks.updatedAt,
    })
    .from(sheetWorkbooks)
    .where(where)
    .orderBy(orderExpr, sheetWorkbooks.id)
    .$dynamic();
  if (filters.limit !== undefined) {
    query = query
      .limit(Math.min(Math.max(filters.limit, 1), 200))
      .offset(Math.max(filters.offset ?? 0, 0));
  }

  const [rows, countRows] = await Promise.all([
    query,
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(sheetWorkbooks)
      .where(where),
  ]);

  return { workbooks: rows, total: countRows[0]?.n ?? 0 };
}

/**
 * Back-compat array-shaped listing (no pagination metadata). Callers that
 * need totals use listSheetWorkbooksPage directly.
 */
export async function listSheetWorkbooks(
  filters: ListSheetWorkbooksFilters,
): Promise<SheetWorkbookMeta[]> {
  return (await listSheetWorkbooksPage(filters)).workbooks;
}

export async function createSheetWorkbook(data: InsertSheetWorkbook): Promise<SheetWorkbook> {
  const snapshotSizeBytes = data.snapshot
    ? Buffer.byteLength(JSON.stringify(data.snapshot), "utf8")
    : 0;
  const [row] = await getDb()
    .insert(sheetWorkbooks)
    .values({ ...data, snapshotSizeBytes })
    .returning();
  return row;
}

export async function updateSheetWorkbook(
  id: string,
  data: Partial<Pick<InsertSheetWorkbook, "name" | "folderId" | "snapshot">>,
): Promise<SheetWorkbook | undefined> {
  const snapshotSizeBytes =
    data.snapshot !== undefined
      ? Buffer.byteLength(JSON.stringify(data.snapshot), "utf8")
      : undefined;

  const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };
  if (snapshotSizeBytes !== undefined) {
    patch.snapshotSizeBytes = snapshotSizeBytes;
  }

  const [row] = await getDb()
    .update(sheetWorkbooks)
    .set(patch)
    .where(eq(sheetWorkbooks.id, id))
    .returning();
  return row;
}

/**
 * Save a snapshot with optimistic concurrency (revision guard).
 *
 * Returns `{ ok: true, workbook }` when the revision matched and the save
 * succeeded, or `{ ok: false, conflict: true, currentRevision }` when the
 * stored revision doesn't match `expectedRevision`.
 */
export function saveSheetWorkbookSnapshot(
  id: string,
  snapshot: unknown,
  expectedRevision: number,
): Promise<
  | { ok: true; workbook: SheetWorkbook }
  | { ok: false; conflict: true; currentRevision: number }
> {
  return withDbAttribution("sheets:saveSnapshot", async () => {
    const snapshotSizeBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");

    const [row] = await getDb()
      .update(sheetWorkbooks)
      .set({
        snapshot: snapshot as any,
        snapshotSizeBytes,
        revision: sql`${sheetWorkbooks.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sheetWorkbooks.id, id),
          eq(sheetWorkbooks.revision, expectedRevision),
        ),
      )
      .returning();

    if (!row) {
      // Revision mismatch — fetch current to tell the caller what it is.
      const current = await getSheetWorkbook(id);
      return {
        ok: false,
        conflict: true,
        currentRevision: current?.revision ?? 0,
      };
    }

    return { ok: true, workbook: row };
  });
}

export async function deleteSheetWorkbook(id: string): Promise<void> {
  await getDb().delete(sheetWorkbooks).where(eq(sheetWorkbooks.id, id));
}

// ---- sheet_workbook_permissions (per-user) ----

export async function listSheetWorkbookPermissions(
  workbookId: string,
): Promise<SheetWorkbookPermission[]> {
  return getDb()
    .select()
    .from(sheetWorkbookPermissions)
    .where(eq(sheetWorkbookPermissions.workbookId, workbookId));
}

export async function getSheetWorkbookPermission(
  workbookId: string,
  userId: string,
): Promise<SheetWorkbookPermission | undefined> {
  const [row] = await getDb()
    .select()
    .from(sheetWorkbookPermissions)
    .where(
      and(
        eq(sheetWorkbookPermissions.workbookId, workbookId),
        eq(sheetWorkbookPermissions.userId, userId),
      ),
    );
  return row;
}

export async function upsertSheetWorkbookPermission(
  data: InsertSheetWorkbookPermission,
): Promise<SheetWorkbookPermission> {
  const [row] = await getDb()
    .insert(sheetWorkbookPermissions)
    .values(data)
    .onConflictDoUpdate({
      target: [sheetWorkbookPermissions.workbookId, sheetWorkbookPermissions.userId],
      set: { role: data.role, grantedBy: data.grantedBy },
    })
    .returning();
  return row;
}

export async function deleteSheetWorkbookPermission(
  workbookId: string,
  userId: string,
): Promise<void> {
  await getDb()
    .delete(sheetWorkbookPermissions)
    .where(
      and(
        eq(sheetWorkbookPermissions.workbookId, workbookId),
        eq(sheetWorkbookPermissions.userId, userId),
      ),
    );
}

// ---- sheet_workbook_role_grants (per-role) ----

export async function listSheetWorkbookRoleGrants(
  workbookId: string,
): Promise<SheetWorkbookRoleGrant[]> {
  return getDb()
    .select()
    .from(sheetWorkbookRoleGrants)
    .where(eq(sheetWorkbookRoleGrants.workbookId, workbookId));
}

export async function getSheetWorkbookRoleGrant(
  workbookId: string,
  role: string,
): Promise<SheetWorkbookRoleGrant | undefined> {
  const [row] = await getDb()
    .select()
    .from(sheetWorkbookRoleGrants)
    .where(
      and(
        eq(sheetWorkbookRoleGrants.workbookId, workbookId),
        eq(sheetWorkbookRoleGrants.role, role),
      ),
    );
  return row;
}

export async function upsertSheetWorkbookRoleGrant(
  data: InsertSheetWorkbookRoleGrant,
): Promise<SheetWorkbookRoleGrant> {
  const [row] = await getDb()
    .insert(sheetWorkbookRoleGrants)
    .values(data)
    .onConflictDoUpdate({
      target: [sheetWorkbookRoleGrants.workbookId, sheetWorkbookRoleGrants.role],
      set: { accessLevel: data.accessLevel, grantedBy: data.grantedBy },
    })
    .returning();
  return row;
}

export async function deleteSheetWorkbookRoleGrant(
  workbookId: string,
  role: string,
): Promise<void> {
  await getDb()
    .delete(sheetWorkbookRoleGrants)
    .where(
      and(
        eq(sheetWorkbookRoleGrants.workbookId, workbookId),
        eq(sheetWorkbookRoleGrants.role, role),
      ),
    );
}

// ---- Access resolution ----

/**
 * Returns the effective access level for a user on a workbook.
 * Resolution order (highest wins):
 *  1. CEO → "owner" (sees everything)
 *  2. workbook owner → "owner"
 *  3. explicit user-level permission row
 *  4. role-level grant matching the user's role
 *  5. null (no access)
 */
export async function getWorkbookAccessLevel(
  workbookId: string,
  userId: string,
  userRole?: string,
): Promise<"owner" | "editor" | "viewer" | null> {
  // CEO gets owner-equivalent access to everything.
  if (userRole === "ceo") return "owner";

  const workbook = await getSheetWorkbook(workbookId);
  if (!workbook) return null;

  if (workbook.ownerId === userId) return "owner";

  // Check explicit user permission.
  const perm = await getSheetWorkbookPermission(workbookId, userId);
  if (perm) {
    if (perm.role === "owner") return "owner";
    if (perm.role === "editor") return "editor";
    return "viewer";
  }

  // Check role grant.
  if (userRole) {
    const roleGrant = await getSheetWorkbookRoleGrant(workbookId, userRole);
    if (roleGrant) {
      return roleGrant.accessLevel === "editor" ? "editor" : "viewer";
    }
  }

  return null;
}

export async function canUserAccessWorkbook(
  workbookId: string,
  userId: string,
  userRole?: string,
): Promise<boolean> {
  const level = await getWorkbookAccessLevel(workbookId, userId, userRole);
  return level !== null;
}

export async function canUserWriteWorkbook(
  workbookId: string,
  userId: string,
  userRole?: string,
): Promise<boolean> {
  const level = await getWorkbookAccessLevel(workbookId, userId, userRole);
  return level === "owner" || level === "editor";
}

// ---- sheet_workbook_locks ----

/**
 * Try to acquire the edit lock for `workbookId` on behalf of `holderUserId`.
 *
 * Succeeds if:
 *   (a) no lock row exists, OR
 *   (b) the existing lock is expired (expiresAt < NOW()), OR
 *   (c) the caller already holds the lock (idempotent re-acquire / refresh).
 *
 * Returns `{ acquired: true, lock }` or `{ acquired: false, lock }` where the
 * returned lock is the current holder.
 */
export function acquireWorkbookLock(
  workbookId: string,
  holderUserId: string,
  holderName: string,
): Promise<{ acquired: true; lock: SheetWorkbookLock } | { acquired: false; lock: SheetWorkbookLock }> {
  return withDbAttribution("sheets:acquireLock", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    // Upsert: insert a new lock row, or update if the existing row is expired
    // OR already owned by the same user.  ON CONFLICT uses the PRIMARY KEY
    // (workbook_id). The DO UPDATE fires only when the WHERE condition holds.
    // drizzle's db.execute(sql`...`) returns the raw pg QueryResult (not
    // the rows array), so we access .rows explicitly for safety.
    const execResult = await getDb().execute(sql`
      INSERT INTO sheet_workbook_locks
        (workbook_id, holder_user_id, holder_name, acquired_at, heartbeat_at, expires_at)
      VALUES
        (${workbookId}, ${holderUserId}, ${holderName}, ${now}, ${now}, ${expiresAt})
      ON CONFLICT (workbook_id) DO UPDATE
        SET holder_user_id = EXCLUDED.holder_user_id,
            holder_name    = EXCLUDED.holder_name,
            acquired_at    = EXCLUDED.acquired_at,
            heartbeat_at   = EXCLUDED.heartbeat_at,
            expires_at     = EXCLUDED.expires_at
        WHERE sheet_workbook_locks.expires_at < NOW()
           OR sheet_workbook_locks.holder_user_id = ${holderUserId}
      RETURNING *
    `) as any;
    const row = Array.isArray(execResult) ? execResult[0] : (execResult?.rows?.[0] ?? undefined);

    if (row) {
      return { acquired: true, lock: dbRowToLock(row) };
    }

    // The upsert was blocked — another user holds a valid lock.
    const current = await getWorkbookLock(workbookId);
    if (!current) {
      // Race: lock expired between our check and now; return a synthetic entry.
      const synthetic: SheetWorkbookLock = {
        workbookId,
        holderUserId,
        holderName,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt,
      };
      return { acquired: true, lock: synthetic };
    }
    return { acquired: false, lock: current };
  });
}

/**
 * Extend the heartbeat for an existing lock held by `holderUserId`.
 * Returns the updated lock, or null if the caller doesn't hold it.
 */
export function heartbeatWorkbookLock(
  workbookId: string,
  holderUserId: string,
): Promise<SheetWorkbookLock | null> {
  return withDbAttribution("sheets:heartbeatLock", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    const heartbeatResult = await getDb().execute(sql`
      UPDATE sheet_workbook_locks
         SET heartbeat_at = ${now},
             expires_at   = ${expiresAt}
       WHERE workbook_id      = ${workbookId}
         AND holder_user_id   = ${holderUserId}
      RETURNING *
    `) as any;
    const row = Array.isArray(heartbeatResult) ? heartbeatResult[0] : (heartbeatResult?.rows?.[0] ?? undefined);

    return row ? dbRowToLock(row) : null;
  });
}

/**
 * Release the lock held by `holderUserId`.
 * Silently succeeds if the lock is already gone or held by someone else.
 */
export function releaseWorkbookLock(
  workbookId: string,
  holderUserId: string,
): Promise<void> {
  return withDbAttribution("sheets:releaseLock", () =>
    getDb()
      .delete(sheetWorkbookLocks)
      .where(
        and(
          eq(sheetWorkbookLocks.workbookId, workbookId),
          eq(sheetWorkbookLocks.holderUserId, holderUserId),
        ),
      )
      .then(() => undefined),
  );
}

/**
 * Get the current lock for a workbook.
 * Returns null if there is no lock OR it has expired.
 */
export function getWorkbookLock(workbookId: string): Promise<SheetWorkbookLock | null> {
  return withDbAttribution("sheets:getLock", async () => {
    const now = new Date();
    const [row] = await getDb()
      .select()
      .from(sheetWorkbookLocks)
      .where(
        and(
          eq(sheetWorkbookLocks.workbookId, workbookId),
          // Only return a lock that hasn't expired.
          sql`${sheetWorkbookLocks.expiresAt} > ${now}`,
        ),
      );
    return row ?? null;
  });
}

/**
 * Sweep and delete all expired lock rows. Called periodically or on startup.
 */
export function pruneExpiredWorkbookLocks(): Promise<number> {
  return withDbAttribution("sheets:pruneLocks", async () => {
    const now = new Date();
    const result = await getDb()
      .delete(sheetWorkbookLocks)
      .where(lt(sheetWorkbookLocks.expiresAt, now))
      .returning({ workbookId: sheetWorkbookLocks.workbookId });
    return result.length;
  });
}

// ---- sheet_workbook_versions ----

// Minimum gap between auto-captured versions (5 minutes).
const MIN_AUTO_VERSION_INTERVAL_MS = 5 * 60 * 1000;

// Retention constants.
const MAX_VERSIONS_PER_WORKBOOK = 100;
const DENSE_WINDOW_MS = 24 * 60 * 60 * 1000;         // 24 h
const DAILY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;     // 7 d
const WEEKLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // 30 d

export async function getSheetWorkbookVersion(
  id: string,
): Promise<SheetWorkbookVersion | undefined> {
  const [row] = await getDb()
    .select()
    .from(sheetWorkbookVersions)
    .where(eq(sheetWorkbookVersions.id, id));
  return row;
}

export async function listSheetWorkbookVersions(
  workbookId: string,
): Promise<SheetWorkbookVersionMeta[]> {
  const rows = await getDb()
    .select({
      id: sheetWorkbookVersions.id,
      workbookId: sheetWorkbookVersions.workbookId,
      snapshotSizeBytes: sheetWorkbookVersions.snapshotSizeBytes,
      createdBy: sheetWorkbookVersions.createdBy,
      label: sheetWorkbookVersions.label,
      isRestorePoint: sheetWorkbookVersions.isRestorePoint,
      createdAt: sheetWorkbookVersions.createdAt,
    })
    .from(sheetWorkbookVersions)
    .where(eq(sheetWorkbookVersions.workbookId, workbookId))
    .orderBy(desc(sheetWorkbookVersions.createdAt));
  return rows;
}

/**
 * Capture an auto version when PATCH /workbooks/:id includes a snapshot,
 * but only if no version was captured in the last MIN_AUTO_VERSION_INTERVAL_MS.
 * Skips silently if the workbook has no snapshot.
 *
 * Returns the created version or null if skipped.
 */
export async function captureAutoVersion(params: {
  workbookId: string;
  snapshot: unknown;
  createdBy: string | undefined;
}): Promise<SheetWorkbookVersion | null> {
  const { workbookId, snapshot, createdBy } = params;

  // Check if a version was captured recently.
  const cutoff = new Date(Date.now() - MIN_AUTO_VERSION_INTERVAL_MS);
  const recentRows = await getDb()
    .select({ id: sheetWorkbookVersions.id, createdAt: sheetWorkbookVersions.createdAt })
    .from(sheetWorkbookVersions)
    .where(eq(sheetWorkbookVersions.workbookId, workbookId))
    .orderBy(desc(sheetWorkbookVersions.createdAt))
    .limit(1);

  if (recentRows.length > 0 && recentRows[0].createdAt > cutoff) {
    return null; // Too soon — skip.
  }

  return createSheetWorkbookVersion({
    workbookId,
    snapshot: snapshot as any,
    createdBy: createdBy ?? null,
    label: null,
    isRestorePoint: false,
  });
}

/**
 * Save a manual "Save version" checkpoint.  Always captures regardless of
 * time since last version.
 */
export async function saveManualVersion(params: {
  workbookId: string;
  snapshot: unknown;
  createdBy: string | undefined;
  label?: string | null;
}): Promise<SheetWorkbookVersion> {
  return createSheetWorkbookVersion({
    workbookId: params.workbookId,
    snapshot: params.snapshot as any,
    createdBy: params.createdBy ?? null,
    label: params.label ?? null,
    isRestorePoint: false,
  });
}

/**
 * Restore a workbook to a specific version.
 *
 * Steps:
 *  1. Load the version to restore.
 *  2. Capture a "restore point" version of the current workbook snapshot
 *     (so the restore is itself undoable).
 *  3. Update the workbook's snapshot to the restored one.
 *
 * Returns the updated workbook.
 */
export async function restoreSheetWorkbookVersion(params: {
  versionId: string;
  workbookId: string;
  restoredBy: string | undefined;
}): Promise<SheetWorkbook> {
  const { versionId, workbookId, restoredBy } = params;

  const version = await getSheetWorkbookVersion(versionId);
  if (!version || version.workbookId !== workbookId) {
    throw new Error("Version not found for this workbook");
  }

  const workbook = await getSheetWorkbook(workbookId);
  if (!workbook) throw new Error("Workbook not found");

  // Capture current state as a restore-point before overwriting.
  if (workbook.snapshot !== null && workbook.snapshot !== undefined) {
    await createSheetWorkbookVersion({
      workbookId,
      snapshot: workbook.snapshot,
      createdBy: restoredBy ?? null,
      label: `Before restore to version from ${version.createdAt.toISOString()}`,
      isRestorePoint: true,
    });
  }

  // Apply the restored snapshot.
  const updated = await updateSheetWorkbook(workbookId, {
    snapshot: version.snapshot as any,
  });
  if (!updated) throw new Error("Failed to update workbook");
  return updated;
}

// ---- internal helpers ----

function dbRowToLock(row: Record<string, unknown>): SheetWorkbookLock {
  return {
    workbookId: row.workbook_id as string,
    holderUserId: row.holder_user_id as string,
    holderName: row.holder_name as string,
    acquiredAt: new Date(row.acquired_at as string),
    heartbeatAt: new Date(row.heartbeat_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

// ---- sheet_data_blocks ----

export async function createSheetDataBlock(
  data: InsertSheetDataBlock,
): Promise<SheetDataBlock> {
  await ensureSheetDataBlocksTable();
  const [row] = await getDb().insert(sheetDataBlocks).values(data).returning();
  return row;
}

export async function getSheetDataBlock(id: string): Promise<SheetDataBlock | undefined> {
  await ensureSheetDataBlocksTable();
  const [row] = await getDb()
    .select()
    .from(sheetDataBlocks)
    .where(eq(sheetDataBlocks.id, id));
  return row;
}

export async function listSheetDataBlocks(workbookId: string): Promise<SheetDataBlock[]> {
  await ensureSheetDataBlocksTable();
  return getDb()
    .select()
    .from(sheetDataBlocks)
    .where(eq(sheetDataBlocks.workbookId, workbookId));
}

export async function listSheetDataBlocksForAutoRefresh(): Promise<SheetDataBlock[]> {
  await ensureSheetDataBlocksTable();
  return getDb()
    .select()
    .from(sheetDataBlocks)
    .where(eq(sheetDataBlocks.autoRefresh, true));
}

export async function updateSheetDataBlock(
  id: string,
  data: Partial<Pick<SheetDataBlock, "label" | "autoRefresh" | "rowCount" | "colCount" | "lastRefreshedAt">>,
): Promise<SheetDataBlock | undefined> {
  await ensureSheetDataBlocksTable();
  const [row] = await getDb()
    .update(sheetDataBlocks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(sheetDataBlocks.id, id))
    .returning();
  return row;
}

export async function deleteSheetDataBlock(id: string): Promise<void> {
  await ensureSheetDataBlocksTable();
  await getDb().delete(sheetDataBlocks).where(eq(sheetDataBlocks.id, id));
}

// ---- sheet_workbook_versions ----

async function createSheetWorkbookVersion(
  data: Omit<InsertSheetWorkbookVersion, "snapshotSizeBytes">,
): Promise<SheetWorkbookVersion> {
  const snapshotSizeBytes = Buffer.byteLength(JSON.stringify(data.snapshot), "utf8");
  const [row] = await getDb()
    .insert(sheetWorkbookVersions)
    .values({ ...data, snapshotSizeBytes } as any)
    .returning();
  // Apply retention policy after insert (fire-and-forget style within same request).
  applyRetentionPolicy(data.workbookId).catch((err) =>
    console.warn("[sheetsStorage] retention policy error:", err?.message ?? err),
  );
  return row;
}

/**
 * Thin old versions according to the retention schedule:
 *  - age <  24 h → keep all
 *  - 1 d ≤ age <  7 d → keep newest per calendar day
 *  - 7 d ≤ age < 30 d → keep newest per calendar week
 *  - age ≥ 30 d → delete
 *
 * Then enforce the hard cap (MAX_VERSIONS_PER_WORKBOOK), removing the oldest
 * non-restore-point versions beyond the cap.
 *
 * Restore-point rows are never thinned (they're always undoable breadcrumbs).
 */
async function applyRetentionPolicy(workbookId: string): Promise<void> {
  const db = getDb();

  // Load all versions for this workbook (newest first), excluding restore points from thinning logic.
  const allVersions = await db
    .select({
      id: sheetWorkbookVersions.id,
      createdAt: sheetWorkbookVersions.createdAt,
      isRestorePoint: sheetWorkbookVersions.isRestorePoint,
    })
    .from(sheetWorkbookVersions)
    .where(eq(sheetWorkbookVersions.workbookId, workbookId))
    .orderBy(desc(sheetWorkbookVersions.createdAt));

  if (allVersions.length === 0) return;

  const now = Date.now();
  const toDelete = new Set<string>();

  // Buckets for daily and weekly de-duplication (only the newest in each bucket is kept).
  const dailyKept = new Set<string>();   // e.g. "2026-07-10"
  const weeklyKept = new Set<string>();  // e.g. "2026-W27"

  for (const v of allVersions) {
    if (v.isRestorePoint) continue; // Never auto-thin restore points.

    const ageMs = now - v.createdAt.getTime();

    if (ageMs >= WEEKLY_WINDOW_MS) {
      // Older than 30 days → always delete.
      toDelete.add(v.id);
    } else if (ageMs >= DAILY_WINDOW_MS) {
      // 7–30 days → keep newest per ISO week.
      const weekKey = isoWeekKey(v.createdAt);
      if (dailyKept.has(weekKey) || weeklyKept.has(weekKey)) {
        toDelete.add(v.id);
      } else {
        weeklyKept.add(weekKey);
      }
    } else if (ageMs >= DENSE_WINDOW_MS) {
      // 1–7 days → keep newest per calendar day.
      const dayKey = dayBucketKey(v.createdAt);
      if (dailyKept.has(dayKey)) {
        toDelete.add(v.id);
      } else {
        dailyKept.add(dayKey);
      }
    }
    // < 24 h → keep all; no action needed.
  }

  // Enforce the hard cap on non-restore-point rows that survive thinning.
  const nonRestoreSurvivors = allVersions.filter(
    (v) => !v.isRestorePoint && !toDelete.has(v.id),
  );
  if (nonRestoreSurvivors.length > MAX_VERSIONS_PER_WORKBOOK) {
    // Array is already newest-first; slice off the tail (oldest).
    const excess = nonRestoreSurvivors.slice(MAX_VERSIONS_PER_WORKBOOK);
    for (const v of excess) {
      toDelete.add(v.id);
    }
  }

  if (toDelete.size === 0) return;

  await db
    .delete(sheetWorkbookVersions)
    .where(
      and(
        eq(sheetWorkbookVersions.workbookId, workbookId),
        inArray(sheetWorkbookVersions.id, [...toDelete]),
      ),
    );
}

function dayBucketKey(d: Date): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isoWeekKey(d: Date): string {
  // ISO week: Thursday of the week determines the year.
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayOfWeek = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const year = date.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((date.getTime() - startOfYear.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

export async function deleteSheetWorkbookVersionsByWorkbook(workbookId: string): Promise<void> {
  await getDb()
    .delete(sheetWorkbookVersions)
    .where(eq(sheetWorkbookVersions.workbookId, workbookId));
}

// ---- duplicate workbook ----

/**
 * Deep-copy a workbook (snapshot + data blocks) into a new workbook owned by
 * `newOwnerId`. All IDs are freshly generated — no shared references with the
 * source. Data blocks are copied with `lastRefreshedAt = null` (stale) so the
 * new owner knows they need a refresh.
 *
 * Returns the new workbook and the count of blocks cloned.
 */
export async function duplicateWorkbook(
  sourceId: string,
  newOwnerId: string,
  newName: string,
  folderId?: string | null,
): Promise<{ workbook: SheetWorkbook; blockCount: number }> {
  await ensureSheetDataBlocksTable();

  return withDbAttribution("sheets:duplicateWorkbook", async () => {
    const source = await getSheetWorkbook(sourceId);
    if (!source) throw new Error(`Workbook ${sourceId} not found`);

    const snapshotCopy = source.snapshot ? JSON.parse(JSON.stringify(source.snapshot)) : null;
    const snapshotSizeBytes = snapshotCopy
      ? Buffer.byteLength(JSON.stringify(snapshotCopy), "utf8")
      : 0;

    const [newWorkbook] = await getDb()
      .insert(sheetWorkbooks)
      .values({
        name: newName,
        folderId: folderId !== undefined ? folderId : null,
        ownerId: newOwnerId,
        snapshot: snapshotCopy,
        snapshotSizeBytes,
        revision: 0,
      })
      .returning();

    const sourceBlocks = await getDb()
      .select()
      .from(sheetDataBlocks)
      .where(eq(sheetDataBlocks.workbookId, sourceId));

    if (sourceBlocks.length > 0) {
      await getDb().insert(sheetDataBlocks).values(
        sourceBlocks.map((b) => ({
          workbookId: newWorkbook.id,
          sheetId: b.sheetId,
          label: b.label,
          connectorId: b.connectorId,
          connectorParams: b.connectorParams,
          startRow: b.startRow,
          startCol: b.startCol,
          rowCount: b.rowCount,
          colCount: b.colCount,
          autoRefresh: b.autoRefresh,
          lastRefreshedAt: null,
          createdBy: newOwnerId,
        })),
      );
    }

    return { workbook: newWorkbook, blockCount: sourceBlocks.length };
  });
}

// ---- sheet_templates ----

let templatesTableEnsured = false;

async function ensureSheetTemplatesTable(): Promise<void> {
  if (templatesTableEnsured) return;
  await withDbAttribution("sheets:ensureTemplatesTable", async () => {
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sheet_templates (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      source_workbook_id varchar REFERENCES sheet_workbooks(id) ON DELETE SET NULL,
      snapshot jsonb,
      data_block_defs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by varchar NOT NULL REFERENCES users(id),
      archived_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sheet_templates_created_by_idx
      ON sheet_templates (created_by)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sheet_templates_archived_at_idx
      ON sheet_templates (archived_at)
  `);
  });
  templatesTableEnsured = true;
}

export async function createSheetTemplate(
  data: InsertSheetTemplate,
): Promise<SheetTemplate> {
  await ensureSheetTemplatesTable();
  return withDbAttribution("sheets:createTemplate", async () => {
    const [row] = await getDb().insert(sheetTemplates).values(data).returning();
    return row;
  });
}

export async function getSheetTemplate(id: string): Promise<SheetTemplate | undefined> {
  await ensureSheetTemplatesTable();
  return withDbAttribution("sheets:getTemplate", async () => {
    const [row] = await getDb()
      .select()
      .from(sheetTemplates)
      .where(eq(sheetTemplates.id, id));
    return row;
  });
}

export async function listSheetTemplates(filters?: {
  includeArchived?: boolean;
}): Promise<SheetTemplate[]> {
  await ensureSheetTemplatesTable();
  const conds = filters?.includeArchived
    ? []
    : [isNull(sheetTemplates.archivedAt)];

  return withDbAttribution("sheets:listTemplates", async () => {
    const query = getDb().select().from(sheetTemplates);
    if (conds.length > 0) {
      return query.where(and(...conds));
    }
    return query;
  });
}

export async function updateSheetTemplate(
  id: string,
  patch: Partial<Pick<InsertSheetTemplate, "name" | "description" | "snapshot" | "dataBlockDefs" | "sourceWorkbookId" | "archivedAt">>,
): Promise<SheetTemplate | undefined> {
  await ensureSheetTemplatesTable();
  return withDbAttribution("sheets:updateTemplate", async () => {
    const [row] = await getDb()
      .update(sheetTemplates)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(sheetTemplates.id, id))
      .returning();
    return row;
  });
}

export async function deleteSheetTemplate(id: string): Promise<void> {
  await ensureSheetTemplatesTable();
  await withDbAttribution("sheets:deleteTemplate", () =>
    getDb().delete(sheetTemplates).where(eq(sheetTemplates.id, id)),
  );
}

/**
 * Create a workbook from a template. Snapshot is deep-copied; data block defs
 * are instantiated as new rows with fresh IDs and lastRefreshedAt=null (stale).
 */
export async function createWorkbookFromTemplate(
  templateId: string,
  ownerId: string,
  name: string,
  folderId?: string | null,
): Promise<{ workbook: SheetWorkbook; blockCount: number }> {
  await ensureSheetTemplatesTable();
  await ensureSheetDataBlocksTable();

  return withDbAttribution("sheets:createFromTemplate", async () => {
    const template = await getSheetTemplate(templateId);
    if (!template) throw new Error(`Template ${templateId} not found`);

    const snapshotCopy = template.snapshot
      ? JSON.parse(JSON.stringify(template.snapshot))
      : null;
    const snapshotSizeBytes = snapshotCopy
      ? Buffer.byteLength(JSON.stringify(snapshotCopy), "utf8")
      : 0;

    const [newWorkbook] = await getDb()
      .insert(sheetWorkbooks)
      .values({
        name,
        folderId: folderId !== undefined ? folderId : null,
        ownerId,
        snapshot: snapshotCopy,
        snapshotSizeBytes,
        revision: 0,
      })
      .returning();

    const defs = Array.isArray(template.dataBlockDefs) ? template.dataBlockDefs : [];
    if (defs.length > 0) {
      await getDb().insert(sheetDataBlocks).values(
        defs.map((def: any) => ({
          workbookId: newWorkbook.id,
          sheetId: def.sheetId ?? "Sheet1",
          label: def.label ?? "Data Block",
          connectorId: def.connectorId ?? "unknown",
          connectorParams: def.connectorParams ?? {},
          startRow: def.startRow ?? 0,
          startCol: def.startCol ?? 0,
          rowCount: def.rowCount ?? 1,
          colCount: def.colCount ?? 1,
          autoRefresh: def.autoRefresh ?? false,
          lastRefreshedAt: null,
          createdBy: ownerId,
        })),
      );
    }

    return { workbook: newWorkbook, blockCount: defs.length };
  });
}

// ---- sheet_workbook_activity ----

// Maximum activity entries kept per workbook (oldest trimmed on each write).
const MAX_ACTIVITY_PER_WORKBOOK = 500;

/** Ensure the activity table exists (idempotent, same pattern as data_blocks). */
let activityTableEnsured = false;
async function ensureSheetActivityTable(): Promise<void> {
  if (activityTableEnsured) return;
  await withDbAttribution("sheets:ensureActivityTable", async () => {
    const db = getDb();
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sheet_workbook_activity (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        workbook_id varchar NOT NULL REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
        actor_id varchar REFERENCES users(id) ON DELETE SET NULL,
        actor_name text NOT NULL DEFAULT '',
        action varchar NOT NULL,
        detail jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS sheet_workbook_activity_workbook_id_idx
        ON sheet_workbook_activity (workbook_id)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS sheet_workbook_activity_workbook_created_at_idx
        ON sheet_workbook_activity (workbook_id, created_at)
    `);
  });
  activityTableEnsured = true;
}

/**
 * Write a single activity entry for a workbook action. Fire-and-forget safe —
 * callers can void the promise; failures are logged but never propagated.
 */
export async function logSheetActivity(params: {
  workbookId: string;
  actorId: string | null | undefined;
  actorName: string;
  action: SheetActivityAction;
  detail?: Record<string, unknown> | null;
}): Promise<SheetWorkbookActivity> {
  await ensureSheetActivityTable();
  const { workbookId, actorId, actorName, action, detail } = params;
  const [row] = await withDbAttribution("sheets:logActivity", () =>
    getDb()
      .insert(sheetWorkbookActivity)
      .values({
        workbookId,
        actorId: actorId ?? null,
        actorName,
        action,
        detail: detail ?? null,
      })
      .returning(),
  );

  // Trim oldest entries beyond the cap (fire-and-forget).
  pruneSheetActivity(workbookId).catch((err) =>
    console.warn("[sheetsStorage] activity prune error:", err?.message ?? err),
  );

  return row;
}

async function pruneSheetActivity(workbookId: string): Promise<void> {
  await withDbAttribution("sheets:pruneActivity", async () => {
    const db = getDb();
    await db.execute(sql`
      DELETE FROM sheet_workbook_activity
      WHERE workbook_id = ${workbookId}
        AND id NOT IN (
          SELECT id FROM sheet_workbook_activity
          WHERE workbook_id = ${workbookId}
          ORDER BY created_at DESC
          LIMIT ${MAX_ACTIVITY_PER_WORKBOOK}
        )
    `);
  });
}

/**
 * List activity entries for a workbook, newest first.
 * Respects an optional `limit` (default 50, max 200).
 */
export async function listSheetWorkbookActivity(
  workbookId: string,
  limit = 50,
): Promise<SheetWorkbookActivity[]> {
  await ensureSheetActivityTable();
  const cap = Math.min(Math.max(1, limit), 200);
  return withDbAttribution("sheets:listActivity", () =>
    getDb()
      .select()
      .from(sheetWorkbookActivity)
      .where(eq(sheetWorkbookActivity.workbookId, workbookId))
      .orderBy(desc(sheetWorkbookActivity.createdAt))
      .limit(cap),
  );
}

/**
 * Return the most recent activity timestamp for each of the given workbook IDs.
 * Used by the library to show "last activity" without an extra per-card query.
 */
export async function getSheetWorkbookLastActivityMap(
  workbookIds: string[],
): Promise<Map<string, Date>> {
  if (workbookIds.length === 0) return new Map();
  await ensureSheetActivityTable();
  const rows = await withDbAttribution("sheets:lastActivityMap", async () =>
    getDb().execute(sql`
      SELECT DISTINCT ON (workbook_id)
        workbook_id,
        created_at
      FROM sheet_workbook_activity
      WHERE workbook_id = ANY(${bindArrayParam(workbookIds, "text")})
      ORDER BY workbook_id, created_at DESC
    `),
  ) as any;
  const result = new Map<string, Date>();
  const raw: Array<{ workbook_id: string; created_at: string }> =
    Array.isArray(rows) ? rows : (rows?.rows ?? []);
  for (const r of raw) {
    result.set(r.workbook_id, new Date(r.created_at));
  }
  return result;
}

/**
 * Save a workbook as a template (or update an existing template from a workbook).
 * When `existingTemplateId` is provided, updates that template's snapshot and
 * block defs from the source workbook. Otherwise creates a new template.
 */
export async function saveWorkbookAsTemplate(
  workbookId: string,
  createdBy: string,
  templateName: string,
  description: string,
  existingTemplateId?: string,
): Promise<SheetTemplate> {
  await ensureSheetDataBlocksTable();
  await ensureSheetTemplatesTable();

  return withDbAttribution("sheets:saveAsTemplate", async () => {
    const workbook = await getSheetWorkbook(workbookId);
    if (!workbook) throw new Error(`Workbook ${workbookId} not found`);

    const blocks = await getDb()
      .select()
      .from(sheetDataBlocks)
      .where(eq(sheetDataBlocks.workbookId, workbookId));

    const snapshotCopy = workbook.snapshot
      ? JSON.parse(JSON.stringify(workbook.snapshot))
      : null;

    const dataBlockDefs = blocks.map((b) => ({
      sheetId: b.sheetId,
      label: b.label,
      connectorId: b.connectorId,
      connectorParams: b.connectorParams,
      startRow: b.startRow,
      startCol: b.startCol,
      rowCount: b.rowCount,
      colCount: b.colCount,
      autoRefresh: b.autoRefresh,
    }));

    if (existingTemplateId) {
      const updated = await updateSheetTemplate(existingTemplateId, {
        name: templateName,
        description,
        snapshot: snapshotCopy,
        dataBlockDefs,
        sourceWorkbookId: workbookId,
      });
      if (!updated) throw new Error(`Template ${existingTemplateId} not found`);
      return updated;
    }

    return createSheetTemplate({
      name: templateName,
      description,
      sourceWorkbookId: workbookId,
      snapshot: snapshotCopy,
      dataBlockDefs,
      createdBy,
    });
  });
}

// ---- sheet_workbook_dashboards ----
// Published read-only dashboard views. One row per workbook (1:1), present only
// when the workbook has been published. Dropping the row unpublishes immediately.

export interface WorkbookDashboard {
  id: string;                      // same as workbookId — one dashboard per workbook
  workbookId: string;
  title: string;
  publishedBy: string;
  publishedAt: Date;
  tabs: DashboardTab[];            // selected tabs to show (empty = all)
  audienceUserIds: string[];       // explicit viewer grant (empty = use workbook perms)
  audienceRoles: string[];         // role-level viewer grant
  updatedAt: Date;
}

export interface DashboardTab {
  sheetId: string;
  sheetName: string;
}

let dashboardsTableEnsured = false;

export async function ensureWorkbookDashboardsTable(): Promise<void> {
  if (dashboardsTableEnsured) return;
  const db = getDb();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sheet_workbook_dashboards (
      workbook_id varchar PRIMARY KEY REFERENCES sheet_workbooks(id) ON DELETE CASCADE,
      title text NOT NULL,
      published_by varchar NOT NULL REFERENCES users(id),
      published_at timestamp NOT NULL DEFAULT now(),
      tabs jsonb NOT NULL DEFAULT '[]'::jsonb,
      audience_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      audience_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS sheet_workbook_dashboards_published_by_idx
      ON sheet_workbook_dashboards (published_by)
  `);
  dashboardsTableEnsured = true;
}

function dbRowToDashboard(row: Record<string, unknown>): WorkbookDashboard {
  const workbookId = row.workbook_id as string;
  return {
    id: workbookId,
    workbookId,
    title: row.title as string,
    publishedBy: row.published_by as string,
    publishedAt: new Date(row.published_at as string),
    tabs: Array.isArray(row.tabs) ? (row.tabs as DashboardTab[]) : [],
    audienceUserIds: Array.isArray(row.audience_user_ids) ? (row.audience_user_ids as string[]) : [],
    audienceRoles: Array.isArray(row.audience_roles) ? (row.audience_roles as string[]) : [],
    updatedAt: new Date(row.updated_at as string),
  };
}

export async function getWorkbookDashboard(
  workbookId: string,
): Promise<WorkbookDashboard | undefined> {
  await ensureWorkbookDashboardsTable();
  const execResult = await getDb().execute(sql`
    SELECT * FROM sheet_workbook_dashboards WHERE workbook_id = ${workbookId}
  `) as any;
  const row = Array.isArray(execResult) ? execResult[0] : (execResult?.rows?.[0] ?? undefined);
  return row ? dbRowToDashboard(row) : undefined;
}

export async function publishWorkbookAsDashboard(
  workbookId: string,
  publishedBy: string,
  config: {
    title: string;
    tabs: DashboardTab[];
    audienceUserIds: string[];
    audienceRoles: string[];
  },
): Promise<WorkbookDashboard> {
  await ensureWorkbookDashboardsTable();
  const now = new Date();
  const execResult = await getDb().execute(sql`
    INSERT INTO sheet_workbook_dashboards
      (workbook_id, title, published_by, published_at, tabs, audience_user_ids, audience_roles, updated_at)
    VALUES
      (${workbookId}, ${config.title}, ${publishedBy}, ${now},
       ${JSON.stringify(config.tabs)}::jsonb,
       ${JSON.stringify(config.audienceUserIds)}::jsonb,
       ${JSON.stringify(config.audienceRoles)}::jsonb,
       ${now})
    ON CONFLICT (workbook_id) DO UPDATE
      SET title             = EXCLUDED.title,
          tabs              = EXCLUDED.tabs,
          audience_user_ids = EXCLUDED.audience_user_ids,
          audience_roles    = EXCLUDED.audience_roles,
          updated_at        = EXCLUDED.updated_at
    RETURNING *
  `) as any;
  const row = Array.isArray(execResult) ? execResult[0] : (execResult?.rows?.[0] ?? undefined);
  if (!row) throw new Error("Failed to publish dashboard");
  return dbRowToDashboard(row);
}

export async function unpublishWorkbookDashboard(workbookId: string): Promise<void> {
  await ensureWorkbookDashboardsTable();
  await getDb().execute(sql`
    DELETE FROM sheet_workbook_dashboards WHERE workbook_id = ${workbookId}
  `);
}

/**
 * Returns all published dashboards visible to the given user.
 * Visibility rules:
 *   1. CEO sees everything.
 *   2. Dashboard has explicit audienceUserIds containing this user.
 *   3. Dashboard has audienceRoles containing this user's role.
 *   4. Both audience arrays are empty → fall back to workbook permission check.
 *   5. User owns the workbook (owner always sees their own dashboards).
 */
export async function listPublishedDashboards(
  userId: string,
  userRole?: string,
): Promise<Array<WorkbookDashboard & { workbookName: string }>> {
  await ensureWorkbookDashboardsTable();
  const execResult = await getDb().execute(sql`
    SELECT d.*, w.name AS workbook_name
    FROM sheet_workbook_dashboards d
    JOIN sheet_workbooks w ON w.id = d.workbook_id
    ORDER BY d.updated_at DESC
  `) as any;
  const rows: Record<string, unknown>[] = Array.isArray(execResult)
    ? execResult
    : (execResult?.rows ?? []);

  const result: Array<WorkbookDashboard & { workbookName: string }> = [];

  for (const row of rows) {
    const dash = dbRowToDashboard(row);
    const workbookName = (row.workbook_name as string) ?? "";

    // CEO sees all
    if (userRole === "ceo") {
      result.push({ ...dash, workbookName });
      continue;
    }

    // Owner always sees their own dashboard (check via workbook owner)
    if (dash.publishedBy === userId) {
      result.push({ ...dash, workbookName });
      continue;
    }

    // Both audience arrays populated — check explicit grants
    const hasUserIds = dash.audienceUserIds.length > 0;
    const hasRoles = dash.audienceRoles.length > 0;

    if (hasUserIds || hasRoles) {
      const userAllowed = hasUserIds && dash.audienceUserIds.includes(userId);
      const roleAllowed = hasRoles && userRole && dash.audienceRoles.includes(userRole);
      if (userAllowed || roleAllowed) {
        result.push({ ...dash, workbookName });
      }
      continue;
    }

    // Neither audience array set — fall back to workbook-level permission
    const level = await getWorkbookAccessLevel(dash.workbookId, userId, userRole);
    if (level !== null) {
      result.push({ ...dash, workbookName });
    }
  }

  // Also surface dashboards for workbooks the owner published (catch missing publishedBy === userId above)
  const ownedResult = await getDb().execute(sql`
    SELECT d.*, w.name AS workbook_name
    FROM sheet_workbook_dashboards d
    JOIN sheet_workbooks w ON w.id = d.workbook_id
    WHERE w.owner_id = ${userId}
    ORDER BY d.updated_at DESC
  `) as any;
  const ownedRows: Record<string, unknown>[] = Array.isArray(ownedResult)
    ? ownedResult
    : (ownedResult?.rows ?? []);
  for (const row of ownedRows) {
    const dash = dbRowToDashboard(row);
    if (!result.some((r) => r.workbookId === dash.workbookId)) {
      result.push({ ...dash, workbookName: (row.workbook_name as string) ?? "" });
    }
  }

  return result;
}

/**
 * Check if a user can view a specific published dashboard.
 * Same rules as listPublishedDashboards but for a single dashboard.
 */
export async function canUserViewDashboard(
  workbookId: string,
  userId: string,
  userRole?: string,
): Promise<boolean> {
  await ensureWorkbookDashboardsTable();
  const dash = await getWorkbookDashboard(workbookId);
  if (!dash) return false;

  if (userRole === "ceo") return true;

  const workbook = await getSheetWorkbook(workbookId);
  if (workbook?.ownerId === userId) return true;

  const hasUserIds = dash.audienceUserIds.length > 0;
  const hasRoles = dash.audienceRoles.length > 0;

  if (hasUserIds || hasRoles) {
    const userAllowed = hasUserIds && dash.audienceUserIds.includes(userId);
    const roleAllowed = hasRoles && userRole != null && dash.audienceRoles.includes(userRole);
    return !!(userAllowed || roleAllowed);
  }

  // Fall back to workbook-level permission
  const level = await getWorkbookAccessLevel(workbookId, userId, userRole);
  return level !== null;
}
