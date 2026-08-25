// @db-pool-intent: ambient
//
// NoBull Docs storage module — CRUD for doc_documents, doc_document_locks
// (edit-locking), doc_document_versions (history + restore), and
// doc_document_activity (audit trail). Deliberately mirrors
// server/storage/sheetsStorage.ts so the two office-suite surfaces share one
// persistence model: JSONB snapshot + optimistic revision guard, single
// active editor lock with heartbeat, auto/manual versions with retention
// thinning, restore points, and a capped activity log.
// Callers on the api pool (request-scoped) and the worker pool (background)
// both route through getDb().

import {
  docDocuments,
  docDocumentLocks,
  docDocumentVersions,
  docDocumentActivity,
  docDocumentPermissions,
  type DocDocumentPermission,
  type InsertDocDocumentPermission,
  type DocAccessLevel,
  type DocDocument,
  type DocDocumentMeta,
  type InsertDocDocument,
  type DocDocumentLock,
  type DocDocumentVersion,
  type InsertDocDocumentVersion,
  type DocDocumentVersionMeta,
  type DocDocumentActivity,
  type DocActivityAction,
} from "@shared/schema";

import { getDb, withDbAttribution } from "../db";
import { and, desc, eq, inArray, isNull, isNotNull, lt, or, sql } from "drizzle-orm";

// Lock TTL: 90 seconds. Client heartbeats every 30 s, so 3 misses = expired.
// Same constants as Sheets — keep in lockstep unless the editors diverge.
const LOCK_TTL_MS = 90_000;

// Minimum gap between auto-captured versions (5 minutes).
const MIN_AUTO_VERSION_INTERVAL_MS = 5 * 60 * 1000;

// Version retention constants (same schedule as Sheets).
const MAX_VERSIONS_PER_DOCUMENT = 100;
const DENSE_WINDOW_MS = 24 * 60 * 60 * 1000;         // 24 h
const DAILY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;     // 7 d
const WEEKLY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // 30 d

// Activity log cap per document.
const MAX_ACTIVITY_PER_DOCUMENT = 500;

// Metadata columns — everything except the heavy `snapshot` JSONB.
const DOC_META_COLUMNS = {
  id: docDocuments.id,
  name: docDocuments.name,
  ownerId: docDocuments.ownerId,
  clientId: docDocuments.clientId,
  snapshotSizeBytes: docDocuments.snapshotSizeBytes,
  revision: docDocuments.revision,
  createdAt: docDocuments.createdAt,
  updatedAt: docDocuments.updatedAt,
} as const;

// ---- doc_documents ----

export function getDocDocument(id: string): Promise<DocDocument | undefined> {
  return withDbAttribution("docs:getDocument", async () => {
    const [row] = await getDb().select().from(docDocuments).where(eq(docDocuments.id, id));
    return row;
  });
}

/**
 * List documents visible to `userId`, returning ONLY metadata columns
 * (no `snapshot` JSONB) so the library query stays fast.
 *
 * Visibility model:
 *  - CEO sees every document.
 *  - Everyone else sees documents they own, PLUS every client-linked
 *    document (client files are team-shared; the docs routes are already
 *    gated to account_manager+), PLUS documents shared with them via a
 *    per-user grant (doc_document_permissions, Task #4053).
 */
export type DocDocumentSortKey = "name" | "updated" | "owner";

export interface ListDocDocumentsFilters {
  userId: string;
  userRole?: string;
  /** Restrict to one client's documents (client-linked docs are team-shared). */
  clientId?: string;
  /** Case-insensitive name substring filter (LIKE wildcards escaped). */
  q?: string;
  sort?: DocDocumentSortKey;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Escape LIKE wildcards in user input for ILIKE substring matching. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function docOrderExpr(sort: DocDocumentSortKey | undefined, dir: "asc" | "desc" | undefined, userId: string) {
  const d = sql.raw(dir === "asc" ? "asc" : "desc");
  switch (sort) {
    case "name":
      return sql`lower(${docDocuments.name}) ${d}`;
    case "owner":
      return sql`(${docDocuments.ownerId} = ${userId}) ${d}`;
    case "updated":
    default:
      return sql`${docDocuments.updatedAt} ${d}`;
  }
}

function applyDocPage(
  query: any,
  filters: { limit?: number; offset?: number },
) {
  if (filters.limit === undefined) return query;
  return query
    .limit(Math.min(Math.max(filters.limit, 1), 200))
    .offset(Math.max(filters.offset ?? 0, 0));
}

/**
 * Paged listing with total matching count (Task #4488 — the library
 * paginates server-side). Same visibility model as listDocDocuments.
 */
export function listDocDocumentsPage(
  filters: ListDocDocumentsFilters,
): Promise<{ documents: DocDocumentMeta[]; total: number }> {
  return withDbAttribution("docs:listDocuments", async () => {
    const conds: any[] = [];

    if (filters.clientId) {
      // Client-linked documents are visible to every account manager —
      // mirror listDocDocumentsByClient: no per-user visibility conds.
      conds.push(eq(docDocuments.clientId, filters.clientId));
    } else if (filters.userRole !== "ceo") {
      const grantedRows = await getDb()
        .select({ documentId: docDocumentPermissions.documentId })
        .from(docDocumentPermissions)
        .where(eq(docDocumentPermissions.userId, filters.userId));
      const grantedIds = grantedRows.map((r) => r.documentId);

      const visibility = [
        eq(docDocuments.ownerId, filters.userId),
        isNotNull(docDocuments.clientId),
      ];
      if (grantedIds.length > 0) {
        visibility.push(inArray(docDocuments.id, grantedIds));
      }
      conds.push(or(...visibility));
    }

    if (filters.q && filters.q.trim()) {
      conds.push(
        sql`${docDocuments.name} ILIKE ${"%" + escapeLike(filters.q.trim()) + "%"}`,
      );
    }

    const where = conds.length > 0 ? and(...conds) : undefined;

    const [documents, countRows] = await Promise.all([
      applyDocPage(
        getDb()
          .select(DOC_META_COLUMNS)
          .from(docDocuments)
          .where(where)
          .orderBy(docOrderExpr(filters.sort, filters.dir, filters.userId), docDocuments.id)
          .$dynamic(),
        filters,
      ),
      getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(docDocuments)
        .where(where),
    ]);

    return { documents, total: countRows[0]?.n ?? 0 };
  });
}

export async function listDocDocuments(filters: {
  userId: string;
  userRole?: string;
}): Promise<DocDocumentMeta[]> {
  return (await listDocDocumentsPage(filters)).documents;
}

// ---- doc_document_permissions (Task #4053) ----

export function listDocDocumentPermissions(
  documentId: string,
): Promise<DocDocumentPermission[]> {
  return withDbAttribution("docs:listPermissions", () =>
    getDb()
      .select()
      .from(docDocumentPermissions)
      .where(eq(docDocumentPermissions.documentId, documentId)),
  );
}

export function getDocDocumentPermission(
  documentId: string,
  userId: string,
): Promise<DocDocumentPermission | undefined> {
  return withDbAttribution("docs:getPermission", async () => {
    const [row] = await getDb()
      .select()
      .from(docDocumentPermissions)
      .where(
        and(
          eq(docDocumentPermissions.documentId, documentId),
          eq(docDocumentPermissions.userId, userId),
        ),
      );
    return row;
  });
}

export function upsertDocDocumentPermission(
  data: InsertDocDocumentPermission,
): Promise<DocDocumentPermission> {
  return withDbAttribution("docs:upsertPermission", async () => {
    const [row] = await getDb()
      .insert(docDocumentPermissions)
      .values(data)
      .onConflictDoUpdate({
        target: [docDocumentPermissions.documentId, docDocumentPermissions.userId],
        set: { role: data.role, grantedBy: data.grantedBy },
      })
      .returning();
    return row;
  });
}

export async function deleteDocDocumentPermission(
  documentId: string,
  userId: string,
): Promise<void> {
  await withDbAttribution("docs:deletePermission", () =>
    getDb()
      .delete(docDocumentPermissions)
      .where(
        and(
          eq(docDocumentPermissions.documentId, documentId),
          eq(docDocumentPermissions.userId, userId),
        ),
      ),
  );
}

/**
 * Effective access level for an already-loaded document row.
 *
 * Precedence (mirrors sheets' getWorkbookAccessLevel, without role grants):
 *  - CEO → "owner" (owner-equivalent everywhere).
 *  - Document owner → "owner".
 *  - Client-linked documents are team-shared and writable → "editor".
 *  - Explicit per-user grant → its role ("editor" | "viewer").
 *  - Otherwise null (no access → 403).
 */
export async function getDocAccessLevel(
  doc: Pick<DocDocument, "id" | "ownerId" | "clientId">,
  userId: string,
  userRole?: string,
): Promise<DocAccessLevel | null> {
  if (userRole === "ceo") return "owner";
  if (doc.ownerId === userId) return "owner";
  if (doc.clientId !== null) return "editor";
  const perm = await getDocDocumentPermission(doc.id, userId);
  if (perm) return perm.role === "editor" ? "editor" : "viewer";
  return null;
}

/**
 * List documents linked to a specific client (metadata only), for the
 * client's Files tab. Newest-updated first.
 */
export function listDocDocumentsByClient(clientId: string): Promise<DocDocumentMeta[]> {
  return withDbAttribution("docs:listByClient", () =>
    getDb()
      .select(DOC_META_COLUMNS)
      .from(docDocuments)
      .where(eq(docDocuments.clientId, clientId))
      .orderBy(desc(docDocuments.updatedAt)),
  );
}

export function createDocDocument(data: InsertDocDocument): Promise<DocDocument> {
  return withDbAttribution("docs:createDocument", async () => {
    const snapshotSizeBytes = data.snapshot
      ? Buffer.byteLength(JSON.stringify(data.snapshot), "utf8")
      : 0;
    const [row] = await getDb()
      .insert(docDocuments)
      .values({ ...data, snapshotSizeBytes })
      .returning();
    return row;
  });
}

export function updateDocDocument(
  id: string,
  data: Partial<Pick<InsertDocDocument, "name" | "clientId" | "snapshot">>,
): Promise<DocDocument | undefined> {
  return withDbAttribution("docs:updateDocument", async () => {
    const snapshotSizeBytes =
      data.snapshot !== undefined
        ? Buffer.byteLength(JSON.stringify(data.snapshot), "utf8")
        : undefined;

    const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };
    if (snapshotSizeBytes !== undefined) {
      patch.snapshotSizeBytes = snapshotSizeBytes;
    }

    const [row] = await getDb()
      .update(docDocuments)
      .set(patch)
      .where(eq(docDocuments.id, id))
      .returning();
    return row;
  });
}

/**
 * Save a snapshot with optimistic concurrency (revision guard).
 *
 * Returns `{ ok: true, document }` when the revision matched and the save
 * succeeded, or `{ ok: false, conflict: true, currentRevision }` when the
 * stored revision doesn't match `expectedRevision`.
 */
export function saveDocDocumentSnapshot(
  id: string,
  snapshot: unknown,
  expectedRevision: number,
): Promise<
  | { ok: true; document: DocDocument }
  | { ok: false; conflict: true; currentRevision: number }
> {
  return withDbAttribution("docs:saveSnapshot", async () => {
    const snapshotSizeBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");

    const [row] = await getDb()
      .update(docDocuments)
      .set({
        snapshot: snapshot as any,
        snapshotSizeBytes,
        revision: sql`${docDocuments.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(docDocuments.id, id),
          eq(docDocuments.revision, expectedRevision),
        ),
      )
      .returning();

    if (!row) {
      // Revision mismatch — fetch current to tell the caller what it is.
      const current = await getDocDocument(id);
      return {
        ok: false,
        conflict: true,
        currentRevision: current?.revision ?? 0,
      };
    }

    return { ok: true, document: row };
  });
}

export async function deleteDocDocument(id: string): Promise<void> {
  await withDbAttribution("docs:deleteDocument", () =>
    getDb().delete(docDocuments).where(eq(docDocuments.id, id)),
  );
}

// ---- doc_document_locks ----

/**
 * Try to acquire the edit lock for `documentId` on behalf of `holderUserId`.
 *
 * Succeeds if:
 *   (a) no lock row exists, OR
 *   (b) the existing lock is expired (expiresAt < NOW()), OR
 *   (c) the caller already holds the lock (idempotent re-acquire / refresh).
 *
 * Returns `{ acquired: true, lock }` or `{ acquired: false, lock }` where the
 * returned lock is the current holder.
 */
export function acquireDocumentLock(
  documentId: string,
  holderUserId: string,
  holderName: string,
): Promise<{ acquired: true; lock: DocDocumentLock } | { acquired: false; lock: DocDocumentLock }> {
  return withDbAttribution("docs:acquireLock", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    // Upsert: insert a new lock row, or update if the existing row is expired
    // OR already owned by the same user.  ON CONFLICT uses the PRIMARY KEY
    // (document_id). The DO UPDATE fires only when the WHERE condition holds.
    // drizzle's db.execute(sql`...`) returns the raw pg QueryResult (not
    // the rows array), so we access .rows explicitly for safety.
    const execResult = await getDb().execute(sql`
      INSERT INTO doc_document_locks
        (document_id, holder_user_id, holder_name, acquired_at, heartbeat_at, expires_at)
      VALUES
        (${documentId}, ${holderUserId}, ${holderName}, ${now}, ${now}, ${expiresAt})
      ON CONFLICT (document_id) DO UPDATE
        SET holder_user_id = EXCLUDED.holder_user_id,
            holder_name    = EXCLUDED.holder_name,
            acquired_at    = EXCLUDED.acquired_at,
            heartbeat_at   = EXCLUDED.heartbeat_at,
            expires_at     = EXCLUDED.expires_at
        WHERE doc_document_locks.expires_at < NOW()
           OR doc_document_locks.holder_user_id = ${holderUserId}
      RETURNING *
    `) as any;
    const row = Array.isArray(execResult) ? execResult[0] : (execResult?.rows?.[0] ?? undefined);

    if (row) {
      return { acquired: true, lock: dbRowToLock(row) };
    }

    // The upsert was blocked — another user holds a valid lock.
    const current = await getDocumentLock(documentId);
    if (!current) {
      // Race: lock expired between our check and now; return a synthetic entry.
      const synthetic: DocDocumentLock = {
        documentId,
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
export function heartbeatDocumentLock(
  documentId: string,
  holderUserId: string,
): Promise<DocDocumentLock | null> {
  return withDbAttribution("docs:heartbeatLock", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    const heartbeatResult = await getDb().execute(sql`
      UPDATE doc_document_locks
         SET heartbeat_at = ${now},
             expires_at   = ${expiresAt}
       WHERE document_id    = ${documentId}
         AND holder_user_id = ${holderUserId}
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
export function releaseDocumentLock(
  documentId: string,
  holderUserId: string,
): Promise<void> {
  return withDbAttribution("docs:releaseLock", () =>
    getDb()
      .delete(docDocumentLocks)
      .where(
        and(
          eq(docDocumentLocks.documentId, documentId),
          eq(docDocumentLocks.holderUserId, holderUserId),
        ),
      )
      .then(() => undefined),
  );
}

/**
 * Get the current lock for a document.
 * Returns null if there is no lock OR it has expired.
 */
export function getDocumentLock(documentId: string): Promise<DocDocumentLock | null> {
  return withDbAttribution("docs:getLock", async () => {
    const now = new Date();
    const [row] = await getDb()
      .select()
      .from(docDocumentLocks)
      .where(
        and(
          eq(docDocumentLocks.documentId, documentId),
          // Only return a lock that hasn't expired.
          sql`${docDocumentLocks.expiresAt} > ${now}`,
        ),
      );
    return row ?? null;
  });
}

/**
 * Sweep and delete all expired lock rows. Called opportunistically.
 */
export function pruneExpiredDocumentLocks(): Promise<number> {
  return withDbAttribution("docs:pruneLocks", async () => {
    const now = new Date();
    const result = await getDb()
      .delete(docDocumentLocks)
      .where(lt(docDocumentLocks.expiresAt, now))
      .returning({ documentId: docDocumentLocks.documentId });
    return result.length;
  });
}

// ---- doc_document_versions ----

export function getDocDocumentVersion(
  id: string,
): Promise<DocDocumentVersion | undefined> {
  return withDbAttribution("docs:getVersion", async () => {
    const [row] = await getDb()
      .select()
      .from(docDocumentVersions)
      .where(eq(docDocumentVersions.id, id));
    return row;
  });
}

export function listDocDocumentVersions(
  documentId: string,
): Promise<DocDocumentVersionMeta[]> {
  return withDbAttribution("docs:listVersions", () =>
    getDb()
      .select({
        id: docDocumentVersions.id,
        documentId: docDocumentVersions.documentId,
        snapshotSizeBytes: docDocumentVersions.snapshotSizeBytes,
        createdBy: docDocumentVersions.createdBy,
        label: docDocumentVersions.label,
        isRestorePoint: docDocumentVersions.isRestorePoint,
        createdAt: docDocumentVersions.createdAt,
      })
      .from(docDocumentVersions)
      .where(eq(docDocumentVersions.documentId, documentId))
      .orderBy(desc(docDocumentVersions.createdAt)),
  );
}

/**
 * Capture an auto version when PATCH /documents/:id includes a snapshot,
 * but only if no version was captured in the last MIN_AUTO_VERSION_INTERVAL_MS.
 *
 * Returns the created version or null if skipped.
 */
export async function captureDocAutoVersion(params: {
  documentId: string;
  snapshot: unknown;
  createdBy: string | undefined;
}): Promise<DocDocumentVersion | null> {
  const { documentId, snapshot, createdBy } = params;

  // Check if a version was captured recently.
  const cutoff = new Date(Date.now() - MIN_AUTO_VERSION_INTERVAL_MS);
  const recentRows = await withDbAttribution("docs:autoVersionCheck", () =>
    getDb()
      .select({ id: docDocumentVersions.id, createdAt: docDocumentVersions.createdAt })
      .from(docDocumentVersions)
      .where(eq(docDocumentVersions.documentId, documentId))
      .orderBy(desc(docDocumentVersions.createdAt))
      .limit(1),
  );

  if (recentRows.length > 0 && recentRows[0].createdAt > cutoff) {
    return null; // Too soon — skip.
  }

  return createDocDocumentVersion({
    documentId,
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
export async function saveDocManualVersion(params: {
  documentId: string;
  snapshot: unknown;
  createdBy: string | undefined;
  label?: string | null;
}): Promise<DocDocumentVersion> {
  return createDocDocumentVersion({
    documentId: params.documentId,
    snapshot: params.snapshot as any,
    createdBy: params.createdBy ?? null,
    label: params.label ?? null,
    isRestorePoint: false,
  });
}

/**
 * Restore a document to a specific version.
 *
 * Steps:
 *  1. Load the version to restore.
 *  2. Capture a "restore point" version of the current document snapshot
 *     (so the restore is itself undoable).
 *  3. Update the document's snapshot to the restored one.
 *
 * Returns the updated document.
 */
export async function restoreDocDocumentVersion(params: {
  versionId: string;
  documentId: string;
  restoredBy: string | undefined;
}): Promise<DocDocument> {
  const { versionId, documentId, restoredBy } = params;

  const version = await getDocDocumentVersion(versionId);
  if (!version || version.documentId !== documentId) {
    throw new Error("Version not found for this document");
  }

  const document = await getDocDocument(documentId);
  if (!document) throw new Error("Document not found");

  // Capture current state as a restore-point before overwriting.
  if (document.snapshot !== null && document.snapshot !== undefined) {
    await createDocDocumentVersion({
      documentId,
      snapshot: document.snapshot,
      createdBy: restoredBy ?? null,
      label: `Before restore to version from ${version.createdAt.toISOString()}`,
      isRestorePoint: true,
    });
  }

  // Apply the restored snapshot through the revision-guarded save so the
  // revision bumps. This makes any other open editor tab's expectedRevision
  // stale — without it, a same-user second tab (which the holder-keyed lock
  // permits) could silently overwrite the restore with its next autosave.
  const result = await saveDocDocumentSnapshot(
    documentId,
    version.snapshot,
    document.revision,
  );
  if (!result.ok) {
    // Someone saved between our read and the restore — surface it rather
    // than clobbering their write.
    throw new Error("Document changed while restoring — reload and retry");
  }
  return result.document;
}

async function createDocDocumentVersion(
  data: Omit<InsertDocDocumentVersion, "snapshotSizeBytes">,
): Promise<DocDocumentVersion> {
  const snapshotSizeBytes = Buffer.byteLength(JSON.stringify(data.snapshot), "utf8");
  const [row] = await withDbAttribution("docs:createVersion", () =>
    getDb()
      .insert(docDocumentVersions)
      .values({ ...data, snapshotSizeBytes } as any)
      .returning(),
  );
  // Apply retention policy after insert (fire-and-forget style within same request).
  applyDocRetentionPolicy(data.documentId).catch((err) =>
    console.warn("[docsStorage] retention policy error:", err?.message ?? err),
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
 * Then enforce the hard cap (MAX_VERSIONS_PER_DOCUMENT), removing the oldest
 * non-restore-point versions beyond the cap.
 *
 * Restore-point rows are never thinned (they're always undoable breadcrumbs).
 */
async function applyDocRetentionPolicy(documentId: string): Promise<void> {
  return withDbAttribution("docs:retentionThinning", async () => {
    const db = getDb();

    const allVersions = await db
      .select({
        id: docDocumentVersions.id,
        createdAt: docDocumentVersions.createdAt,
        isRestorePoint: docDocumentVersions.isRestorePoint,
      })
      .from(docDocumentVersions)
      .where(eq(docDocumentVersions.documentId, documentId))
      .orderBy(desc(docDocumentVersions.createdAt));

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
    if (nonRestoreSurvivors.length > MAX_VERSIONS_PER_DOCUMENT) {
      // Array is already newest-first; slice off the tail (oldest).
      const excess = nonRestoreSurvivors.slice(MAX_VERSIONS_PER_DOCUMENT);
      for (const v of excess) {
        toDelete.add(v.id);
      }
    }

    if (toDelete.size === 0) return;

    await db
      .delete(docDocumentVersions)
      .where(
        and(
          eq(docDocumentVersions.documentId, documentId),
          inArray(docDocumentVersions.id, [...toDelete]),
        ),
      );
  });
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

// ---- doc_document_activity ----

export async function logDocActivity(params: {
  documentId: string;
  actorId: string | null | undefined;
  actorName: string;
  action: DocActivityAction;
  detail?: Record<string, unknown> | null;
}): Promise<DocDocumentActivity> {
  const { documentId, actorId, actorName, action, detail } = params;
  const [row] = await withDbAttribution("docs:logActivity", () =>
    getDb()
      .insert(docDocumentActivity)
      .values({
        documentId,
        actorId: actorId ?? null,
        actorName,
        action,
        detail: detail ?? null,
      })
      .returning(),
  );

  // Trim oldest entries beyond the cap (fire-and-forget).
  pruneDocActivity(documentId).catch((err) =>
    console.warn("[docsStorage] activity prune error:", err?.message ?? err),
  );

  return row;
}

async function pruneDocActivity(documentId: string): Promise<void> {
  await withDbAttribution("docs:pruneActivity", async () => {
    const db = getDb();
    await db.execute(sql`
      DELETE FROM doc_document_activity
      WHERE document_id = ${documentId}
        AND id NOT IN (
          SELECT id FROM doc_document_activity
          WHERE document_id = ${documentId}
          ORDER BY created_at DESC
          LIMIT ${MAX_ACTIVITY_PER_DOCUMENT}
        )
    `);
  });
}

/**
 * List activity entries for a document, newest first.
 * Respects an optional `limit` (default 50, max 200).
 */
export function listDocDocumentActivity(
  documentId: string,
  limit = 50,
): Promise<DocDocumentActivity[]> {
  const cap = Math.min(Math.max(1, limit), 200);
  return withDbAttribution("docs:listActivity", () =>
    getDb()
      .select()
      .from(docDocumentActivity)
      .where(eq(docDocumentActivity.documentId, documentId))
      .orderBy(desc(docDocumentActivity.createdAt))
      .limit(cap),
  );
}

// ---- internal helpers ----

function dbRowToLock(row: Record<string, unknown>): DocDocumentLock {
  return {
    documentId: row.document_id as string,
    holderUserId: row.holder_user_id as string,
    holderName: row.holder_name as string,
    acquiredAt: new Date(row.acquired_at as string),
    heartbeatAt: new Date(row.heartbeat_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}
