// @db-pool-intent: ambient
/**
 * Task #4023 — DB layer for in-app client file storage.
 *
 * Pure DB operations (folders, files, versions, trash, activity, usage) —
 * NO object-storage IO here. Routes and the trash-purge sweep orchestrate
 * storage effects around these functions, in this order:
 *
 *   upload  : storage verify+ACL first, then `claimUploadedFile` (DB);
 *   purge   : `listPurgeTargets` (DB read) → delete objects (storage) →
 *             `purgeFileRows` (DB) for the files whose objects are gone.
 *
 * Purge deletes objects BEFORE rows deliberately: a dangling DB row is
 * visible (404 on download) and re-purgeable, while an orphaned CLAIMED
 * object is invisible forever (the abandoned-upload sweep skips owned
 * objects). Files whose object deletes fail stay in trash for a retry.
 *
 * CONCURRENCY — every mutating operation takes a per-client advisory
 * transaction lock (`lockClientFileSpace`), serializing name-slot claims,
 * folder-tree edits and version swaps within one client while leaving other
 * clients fully concurrent. The partial unique indexes from the migration
 * (`*_live_name_unique`) remain as a backstop; a 23505 surfacing anyway maps
 * to HTTP 409 in the routes.
 *
 * INVARIANT — `client_files.object_key` holds CURRENT content;
 * `client_file_versions` rows hold PRIOR content. Every storage key exists
 * in exactly one row across the two tables: supersede INSERTS the old
 * current into versions, restore SWAPS keys (deleting the restored version
 * row), purge returns the union of both for deletion.
 */
import { and, asc, desc, eq, gt, ilike, inArray, isNull, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, withDbAttribution } from "../db";
import {
  clientFileActivity,
  clientFileFolders,
  clientFileShareLinks,
  clientFileVersions,
  clientFiles,
  clients,
  type ClientFileShareLink,
  type ClientFile,
  type ClientFileActivityAction,
  type ClientFileFolder,
  type ClientFileVersion,
} from "@shared/schema";
import { numberedFileName, type ClientFileKind } from "@shared/clientFiles";

export interface FileActor {
  /** users.id — or null for system actors (retention sweep); the activity
   * table's actor_id FK requires NULL rather than a synthetic id. */
  id: string | null;
  name: string;
}

/** Serialize all structural mutations within one client's file space. */
async function lockClientFileSpace(tx: any, clientId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"client-files:" + clientId}, 42))`,
  );
}

async function logActivity(
  dbx: any,
  entry: {
    clientId: string;
    fileId?: string | null;
    folderId?: string | null;
    action: ClientFileActivityAction;
    actor: FileActor;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await dbx.insert(clientFileActivity).values({
    clientId: entry.clientId,
    fileId: entry.fileId ?? null,
    folderId: entry.folderId ?? null,
    action: entry.action,
    actorId: entry.actor.id,
    actorName: entry.actor.name,
    detail: entry.detail ?? null,
  });
}

export class ClientFileError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "conflict"
      | "invalid"
      | "cycle",
    message: string,
  ) {
    super(message);
    this.name = "ClientFileError";
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

export async function getClientLite(
  clientId: string,
): Promise<{ id: string; firmName: string; ownerId: string | null } | null> {
  return withDbAttribution("clientFiles:getClientLite", async () => {
    const rows = await getDb()
      .select({
        id: clients.id,
        firmName: clients.firmName,
        ownerId: clients.ownerId,
      })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface FolderBreadcrumb {
  id: string;
  name: string;
}

/** Root→leaf breadcrumb chain. Throws not_found when the folder isn't the client's. */
export async function getFolderPath(
  clientId: string,
  folderId: string,
): Promise<FolderBreadcrumb[]> {
  return withDbAttribution("clientFiles:getFolderPath", async () => {
    const result = await getDb().execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, name, 0 AS depth
        FROM client_file_folders
        WHERE id = ${folderId} AND client_id = ${clientId}
        UNION ALL
        SELECT f.id, f.parent_id, f.name, c.depth + 1
        FROM client_file_folders f
        JOIN chain c ON f.id = c.parent_id
        WHERE c.depth < 100
      )
      SELECT id, name FROM chain ORDER BY depth DESC
    `);
    const rows = (result as any).rows as { id: string; name: string }[];
    if (rows.length === 0) throw new ClientFileError("not_found", "Folder not found");
    return rows.map((r) => ({ id: r.id, name: r.name }));
  });
}

export interface BrowseResult {
  folders: ClientFileFolder[];
  files: ClientFile[];
  breadcrumbs: FolderBreadcrumb[];
}

export async function browseFolder(
  clientId: string,
  folderId: string | null,
): Promise<BrowseResult> {
  return withDbAttribution("clientFiles:browseFolder", async () => {
    const dbx = getDb();
    const breadcrumbs = folderId ? await getFolderPath(clientId, folderId) : [];
    const folderScope = folderId
      ? eq(clientFileFolders.parentId, folderId)
      : isNull(clientFileFolders.parentId);
    const fileScope = folderId
      ? eq(clientFiles.folderId, folderId)
      : isNull(clientFiles.folderId);
    const [folders, files] = await Promise.all([
      dbx
        .select()
        .from(clientFileFolders)
        .where(and(eq(clientFileFolders.clientId, clientId), folderScope))
        .orderBy(asc(sql`lower(${clientFileFolders.name})`)),
      dbx
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, clientId),
            fileScope,
            isNull(clientFiles.trashedAt),
          ),
        )
        .orderBy(asc(sql`lower(${clientFiles.name})`)),
    ]);
    return { folders, files, breadcrumbs };
  });
}

/** Flat folder list for the move dialog / tree sidebar. */
export async function listAllFolders(
  clientId: string,
): Promise<Pick<ClientFileFolder, "id" | "parentId" | "name">[]> {
  return withDbAttribution("clientFiles:listAllFolders", async () => {
    return getDb()
      .select({
        id: clientFileFolders.id,
        parentId: clientFileFolders.parentId,
        name: clientFileFolders.name,
      })
      .from(clientFileFolders)
      .where(eq(clientFileFolders.clientId, clientId))
      .orderBy(asc(sql`lower(${clientFileFolders.name})`));
  });
}

export async function listTrash(clientId: string): Promise<ClientFile[]> {
  return withDbAttribution("clientFiles:listTrash", async () => {
    return getDb()
      .select()
      .from(clientFiles)
      .where(and(eq(clientFiles.clientId, clientId), isNotNull(clientFiles.trashedAt)))
      .orderBy(desc(clientFiles.trashedAt));
  });
}

export async function getFile(
  clientId: string,
  fileId: string,
): Promise<ClientFile | null> {
  return withDbAttribution("clientFiles:getFile", async () => {
    const rows = await getDb()
      .select()
      .from(clientFiles)
      .where(and(eq(clientFiles.id, fileId), eq(clientFiles.clientId, clientId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function listVersions(
  clientId: string,
  fileId: string,
): Promise<ClientFileVersion[]> {
  return withDbAttribution("clientFiles:listVersions", async () => {
    return getDb()
      .select()
      .from(clientFileVersions)
      .where(
        and(
          eq(clientFileVersions.fileId, fileId),
          eq(clientFileVersions.clientId, clientId),
        ),
      )
      .orderBy(desc(clientFileVersions.versionNumber));
  });
}

export async function listFileActivity(
  clientId: string,
  fileId: string,
  limit = 50,
): Promise<(typeof clientFileActivity.$inferSelect)[]> {
  return withDbAttribution("clientFiles:listFileActivity", async () => {
    return getDb()
      .select()
      .from(clientFileActivity)
      .where(
        and(
          eq(clientFileActivity.fileId, fileId),
          eq(clientFileActivity.clientId, clientId),
        ),
      )
      .orderBy(desc(clientFileActivity.createdAt))
      .limit(limit);
  });
}

export async function listClientActivity(
  clientId: string,
  limit = 100,
): Promise<(typeof clientFileActivity.$inferSelect)[]> {
  return withDbAttribution("clientFiles:listClientActivity", async () => {
    return getDb()
      .select()
      .from(clientFileActivity)
      .where(eq(clientFileActivity.clientId, clientId))
      .orderBy(desc(clientFileActivity.createdAt))
      .limit(limit);
  });
}

// ── Search ─────────────────────────────────────────────────────────────────

/** Mime-based SQL condition per display kind (mirrors classifyClientFileKind). */
function kindCondition(kind: ClientFileKind): SQL | undefined {
  const m = clientFiles.mimeType;
  switch (kind) {
    case "image":
      return ilike(m, "image/%");
    case "video":
      return ilike(m, "video/%");
    case "audio":
      return ilike(m, "audio/%");
    case "pdf":
      return eq(m, "application/pdf");
    case "text":
      return or(ilike(m, "text/%"), eq(m, "application/json"));
    case "sheet":
      return inArray(m, [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
      ]);
    case "doc":
      return inArray(m, [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
        "application/rtf",
      ]);
    case "slides":
      return inArray(m, [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint",
      ]);
    case "archive":
      return inArray(m, [
        "application/zip",
        "application/gzip",
        "application/vnd.rar",
        "application/x-7z-compressed",
      ]);
    case "other":
      return and(
        sql`${m} NOT ILIKE 'image/%'`,
        sql`${m} NOT ILIKE 'video/%'`,
        sql`${m} NOT ILIKE 'audio/%'`,
        sql`${m} NOT ILIKE 'text/%'`,
        sql`${m} NOT IN (
          'application/pdf', 'application/json',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'application/rtf',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint',
          'application/zip', 'application/gzip', 'application/vnd.rar', 'application/x-7z-compressed'
        )`,
      );
    default:
      return undefined;
  }
}

export type FileSortKey = "name" | "size" | "modified" | "client" | "folder";

export interface SearchFilesParams {
  clientId?: string;
  q?: string;
  kind?: ClientFileKind;
  sort?: FileSortKey;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface SearchFileRow extends ClientFile {
  folderName: string | null;
  firmName: string;
}

export interface SearchFilesResult {
  files: SearchFileRow[];
  total: number;
}

/** Live-file search; per-client when clientId set, cross-client otherwise. */
export async function searchFiles(params: SearchFilesParams): Promise<SearchFilesResult> {
  return withDbAttribution("clientFiles:searchFiles", async () => {
    const dbx = getDb();
    const conds: (SQL | undefined)[] = [isNull(clientFiles.trashedAt)];
    if (params.clientId) conds.push(eq(clientFiles.clientId, params.clientId));
    if (params.q && params.q.trim()) {
      // escape LIKE wildcards in user input
      const esc = params.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
      conds.push(ilike(clientFiles.name, `%${esc}%`));
    }
    if (params.kind) conds.push(kindCondition(params.kind));
    const where = and(...conds.filter((c): c is SQL => !!c));
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);
    const dirFn = params.dir === "asc" ? asc : desc;
    const orderExpr =
      params.sort === "name"
        ? dirFn(sql`lower(${clientFiles.name})`)
        : params.sort === "size"
          ? dirFn(clientFiles.sizeBytes)
          : params.sort === "client"
            ? dirFn(sql`lower(${clients.firmName})`)
            : params.sort === "folder"
              ? sql`lower(${clientFileFolders.name}) ${sql.raw(params.dir === "asc" ? "asc" : "desc")} NULLS LAST`
              : dirFn(clientFiles.contentUpdatedAt);

    const [rows, countRows] = await Promise.all([
      dbx
        .select({
          file: clientFiles,
          folderName: clientFileFolders.name,
          firmName: clients.firmName,
        })
        .from(clientFiles)
        .leftJoin(clientFileFolders, eq(clientFiles.folderId, clientFileFolders.id))
        .innerJoin(clients, eq(clientFiles.clientId, clients.id))
        .where(where)
        .orderBy(orderExpr)
        .limit(limit)
        .offset(offset),
      dbx
        .select({ n: sql<number>`count(*)::int` })
        .from(clientFiles)
        .where(where),
    ]);
    return {
      files: rows.map((r) => ({ ...r.file, folderName: r.folderName, firmName: r.firmName })),
      total: countRows[0]?.n ?? 0,
    };
  });
}

// ── Folder mutations ───────────────────────────────────────────────────────

async function assertFolderOfClient(
  tx: any,
  clientId: string,
  folderId: string,
): Promise<ClientFileFolder> {
  const rows = await tx
    .select()
    .from(clientFileFolders)
    .where(and(eq(clientFileFolders.id, folderId), eq(clientFileFolders.clientId, clientId)))
    .limit(1);
  if (!rows[0]) throw new ClientFileError("not_found", "Folder not found");
  return rows[0];
}

async function liveFolderNameTaken(
  tx: any,
  clientId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [
    eq(clientFileFolders.clientId, clientId),
    parentId ? eq(clientFileFolders.parentId, parentId) : isNull(clientFileFolders.parentId),
    sql`lower(${clientFileFolders.name}) = lower(${name})`,
  ];
  if (excludeId) conds.push(sql`${clientFileFolders.id} <> ${excludeId}`);
  const rows = await tx
    .select({ id: clientFileFolders.id })
    .from(clientFileFolders)
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}

async function liveFileNameTaken(
  tx: any,
  clientId: string,
  folderId: string | null,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [
    eq(clientFiles.clientId, clientId),
    folderId ? eq(clientFiles.folderId, folderId) : isNull(clientFiles.folderId),
    isNull(clientFiles.trashedAt),
    sql`lower(${clientFiles.name}) = lower(${name})`,
  ];
  if (excludeId) conds.push(sql`${clientFiles.id} <> ${excludeId}`);
  const rows = await tx
    .select({ id: clientFiles.id })
    .from(clientFiles)
    .where(and(...conds))
    .limit(1);
  return rows.length > 0;
}

async function findAvailableFileName(
  tx: any,
  clientId: string,
  folderId: string | null,
  desired: string,
): Promise<string> {
  if (!(await liveFileNameTaken(tx, clientId, folderId, desired))) return desired;
  for (let n = 2; n <= 200; n++) {
    const candidate = numberedFileName(desired, n);
    if (!(await liveFileNameTaken(tx, clientId, folderId, candidate))) return candidate;
  }
  throw new ClientFileError("conflict", "Could not find an available name");
}

export async function findLiveFolderByName(
  clientId: string,
  parentId: string | null,
  name: string,
): Promise<ClientFileFolder | null> {
  return withDbAttribution("clientFiles:findLiveFolderByName", async () => {
    const rows = await getDb()
      .select()
      .from(clientFileFolders)
      .where(
        and(
          eq(clientFileFolders.clientId, clientId),
          parentId ? eq(clientFileFolders.parentId, parentId) : isNull(clientFileFolders.parentId),
          sql`lower(${clientFileFolders.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}
export async function createFolder(args: {
  clientId: string;
  parentId: string | null;
  name: string;
  actor: FileActor;
}): Promise<ClientFileFolder> {
  return withDbAttribution("clientFiles:createFolder", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      if (args.parentId) await assertFolderOfClient(tx, args.clientId, args.parentId);
      if (await liveFolderNameTaken(tx, args.clientId, args.parentId, args.name)) {
        throw new ClientFileError("conflict", "A folder with this name already exists here");
      }
      const [folder] = await tx
        .insert(clientFileFolders)
        .values({
          clientId: args.clientId,
          parentId: args.parentId,
          name: args.name,
          createdBy: args.actor.id,
        })
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        folderId: folder.id,
        action: "folder_created",
        actor: args.actor,
        detail: { name: args.name },
      });
      return folder;
    });
  });
}

export async function renameFolder(args: {
  clientId: string;
  folderId: string;
  name: string;
  actor: FileActor;
}): Promise<ClientFileFolder> {
  return withDbAttribution("clientFiles:renameFolder", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const folder = await assertFolderOfClient(tx, args.clientId, args.folderId);
      if (folder.name === args.name) return folder;
      if (
        await liveFolderNameTaken(tx, args.clientId, folder.parentId, args.name, folder.id)
      ) {
        throw new ClientFileError("conflict", "A folder with this name already exists here");
      }
      const [updated] = await tx
        .update(clientFileFolders)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(clientFileFolders.id, folder.id))
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        folderId: folder.id,
        action: "folder_renamed",
        actor: args.actor,
        detail: { from: folder.name, to: args.name },
      });
      return updated;
    });
  });
}

/** Subtree folder ids (root included) via recursive CTE. Call inside a tx. */
async function folderSubtreeIds(
  tx: any,
  clientId: string,
  folderId: string,
): Promise<string[]> {
  const result = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM client_file_folders
      WHERE id = ${folderId} AND client_id = ${clientId}
      UNION ALL
      SELECT f.id, s.depth + 1 FROM client_file_folders f
      JOIN subtree s ON f.parent_id = s.id
      WHERE s.depth < 100
    )
    SELECT id FROM subtree
  `);
  return ((result as any).rows as { id: string }[]).map((r) => r.id);
}

export async function moveFolder(args: {
  clientId: string;
  folderId: string;
  newParentId: string | null;
  actor: FileActor;
}): Promise<ClientFileFolder> {
  return withDbAttribution("clientFiles:moveFolder", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const folder = await assertFolderOfClient(tx, args.clientId, args.folderId);
      if (args.newParentId) {
        await assertFolderOfClient(tx, args.clientId, args.newParentId);
        // Reject moves into the folder's own subtree (cycle).
        const subtree = await folderSubtreeIds(tx, args.clientId, folder.id);
        if (subtree.includes(args.newParentId)) {
          throw new ClientFileError("cycle", "Cannot move a folder into itself");
        }
      }
      if ((folder.parentId ?? null) === (args.newParentId ?? null)) return folder;
      if (
        await liveFolderNameTaken(tx, args.clientId, args.newParentId, folder.name, folder.id)
      ) {
        throw new ClientFileError("conflict", "A folder with this name already exists there");
      }
      const [updated] = await tx
        .update(clientFileFolders)
        .set({ parentId: args.newParentId, updatedAt: new Date() })
        .where(eq(clientFileFolders.id, folder.id))
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        folderId: folder.id,
        action: "folder_moved",
        actor: args.actor,
        detail: { name: folder.name },
      });
      return updated;
    });
  });
}

/**
 * Delete a folder subtree: every live file inside moves to Trash
 * (remembering its folder), then the folder rows are hard-deleted
 * (children cascade). Trashed files already have folderId NULL, so nothing
 * dangles.
 */
export async function deleteFolder(args: {
  clientId: string;
  folderId: string;
  actor: FileActor;
}): Promise<{ trashedFileCount: number }> {
  return withDbAttribution("clientFiles:deleteFolder", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const folder = await assertFolderOfClient(tx, args.clientId, args.folderId);
      const subtree = await folderSubtreeIds(tx, args.clientId, folder.id);
      const now = new Date();
      const trashed = await tx
        .update(clientFiles)
        .set({
          trashedAt: now,
          trashedBy: args.actor.id,
          // The containing folder is going away — restores land at root.
          trashedFromFolderId: null,
          folderId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            inArray(clientFiles.folderId, subtree),
            isNull(clientFiles.trashedAt),
          ),
        )
        .returning({ id: clientFiles.id, name: clientFiles.name });
      for (const f of trashed) {
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: f.id,
          action: "trashed",
          actor: args.actor,
          detail: { name: f.name, via: "folder_deleted", folderName: folder.name },
        });
      }
      await tx.delete(clientFileFolders).where(eq(clientFileFolders.id, folder.id));
      await logActivity(tx, {
        clientId: args.clientId,
        folderId: folder.id,
        action: "folder_deleted",
        actor: args.actor,
        detail: {
          name: folder.name,
          subtreeFolders: subtree.length,
          trashedFiles: trashed.length,
        },
      });
      return { trashedFileCount: trashed.length };
    });
  });
}

// ── File mutations ─────────────────────────────────────────────────────────

export interface ClaimResult {
  file: ClientFile;
  /** Set when the upload superseded an existing live file of the same name. */
  supersededVersionNumber?: number;
}

/**
 * Persist a verified upload. Same-name live file in the target folder ⇒
 * the old current content becomes a version row and the file row now points
 * at the new object (Drive-style "keep as prior version").
 */
export async function claimUploadedFile(args: {
  clientId: string;
  folderId: string | null;
  name: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  actor: FileActor;
}): Promise<ClaimResult> {
  return withDbAttribution("clientFiles:claimUploadedFile", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      if (args.folderId) await assertFolderOfClient(tx, args.clientId, args.folderId);
      const now = new Date();
      const existingRows = await tx
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            args.folderId
              ? eq(clientFiles.folderId, args.folderId)
              : isNull(clientFiles.folderId),
            isNull(clientFiles.trashedAt),
            sql`lower(${clientFiles.name}) = lower(${args.name})`,
          ),
        )
        .limit(1);
      const existing = existingRows[0];

      if (existing) {
        const maxRows = await tx
          .select({ n: sql<number>`coalesce(max(${clientFileVersions.versionNumber}), 0)::int` })
          .from(clientFileVersions)
          .where(eq(clientFileVersions.fileId, existing.id));
        const nextVersion = (maxRows[0]?.n ?? 0) + 1;
        await tx.insert(clientFileVersions).values({
          fileId: existing.id,
          clientId: args.clientId,
          versionNumber: nextVersion,
          mimeType: existing.mimeType,
          sizeBytes: existing.sizeBytes,
          objectKey: existing.objectKey,
          uploadedBy: existing.uploadedBy,
          uploadedAt: existing.contentUpdatedAt,
        });
        const [updated] = await tx
          .update(clientFiles)
          .set({
            objectKey: args.objectKey,
            mimeType: args.mimeType,
            sizeBytes: args.sizeBytes,
            uploadedBy: args.actor.id,
            contentUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(clientFiles.id, existing.id))
          .returning();
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: existing.id,
          action: "version_uploaded",
          actor: args.actor,
          detail: {
            name: existing.name,
            priorVersionNumber: nextVersion,
            sizeBytes: args.sizeBytes,
          },
        });
        return { file: updated, supersededVersionNumber: nextVersion };
      }

      const [file] = await tx
        .insert(clientFiles)
        .values({
          clientId: args.clientId,
          folderId: args.folderId,
          name: args.name,
          mimeType: args.mimeType,
          sizeBytes: args.sizeBytes,
          objectKey: args.objectKey,
          uploadedBy: args.actor.id,
        })
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: file.id,
        action: "uploaded",
        actor: args.actor,
        detail: { name: args.name, sizeBytes: args.sizeBytes },
      });
      return { file };
    });
  });
}

export async function renameFile(args: {
  clientId: string;
  fileId: string;
  name: string;
  actor: FileActor;
}): Promise<ClientFile> {
  return withDbAttribution("clientFiles:renameFile", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const rows = await tx
        .select()
        .from(clientFiles)
        .where(and(eq(clientFiles.id, args.fileId), eq(clientFiles.clientId, args.clientId)))
        .limit(1);
      const file = rows[0];
      if (!file) throw new ClientFileError("not_found", "File not found");
      if (file.trashedAt) throw new ClientFileError("invalid", "Cannot rename a trashed file");
      if (file.name === args.name) return file;
      if (
        await liveFileNameTaken(tx, args.clientId, file.folderId, args.name, file.id)
      ) {
        throw new ClientFileError("conflict", "A file with this name already exists here");
      }
      const [updated] = await tx
        .update(clientFiles)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(clientFiles.id, file.id))
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: file.id,
        action: "renamed",
        actor: args.actor,
        detail: { from: file.name, to: args.name },
      });
      return updated;
    });
  });
}

export async function moveFiles(args: {
  clientId: string;
  fileIds: string[];
  folderId: string | null;
  actor: FileActor;
}): Promise<{ moved: number }> {
  return withDbAttribution("clientFiles:moveFiles", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      let targetName: string | null = null;
      if (args.folderId) {
        const target = await assertFolderOfClient(tx, args.clientId, args.folderId);
        targetName = target.name;
      }
      const rows = await tx
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            inArray(clientFiles.id, args.fileIds),
            isNull(clientFiles.trashedAt),
          ),
        );
      let moved = 0;
      for (const file of rows) {
        if ((file.folderId ?? null) === (args.folderId ?? null)) continue;
        const finalName = await findAvailableFileName(
          tx,
          args.clientId,
          args.folderId,
          file.name,
        );
        await tx
          .update(clientFiles)
          .set({ folderId: args.folderId, name: finalName, updatedAt: new Date() })
          .where(eq(clientFiles.id, file.id));
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: file.id,
          action: "moved",
          actor: args.actor,
          detail: {
            name: finalName,
            toFolderId: args.folderId,
            toFolderName: targetName ?? "Files root",
            ...(finalName !== file.name ? { renamedFrom: file.name } : {}),
          },
        });
        moved++;
      }
      return { moved };
    });
  });
}

export async function trashFiles(args: {
  clientId: string;
  fileIds: string[];
  actor: FileActor;
}): Promise<{ trashed: number }> {
  return withDbAttribution("clientFiles:trashFiles", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const now = new Date();
      const rows = await tx
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            inArray(clientFiles.id, args.fileIds),
            isNull(clientFiles.trashedAt),
          ),
        );
      for (const file of rows) {
        await tx
          .update(clientFiles)
          .set({
            trashedAt: now,
            trashedBy: args.actor.id,
            trashedFromFolderId: file.folderId,
            folderId: null,
            updatedAt: now,
          })
          .where(eq(clientFiles.id, file.id));
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: file.id,
          action: "trashed",
          actor: args.actor,
          detail: { name: file.name },
        });
      }
      return { trashed: rows.length };
    });
  });
}

export async function restoreFiles(args: {
  clientId: string;
  fileIds: string[];
  actor: FileActor;
}): Promise<{ restored: number }> {
  return withDbAttribution("clientFiles:restoreFiles", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const rows = await tx
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            inArray(clientFiles.id, args.fileIds),
            isNotNull(clientFiles.trashedAt),
          ),
        );
      let restored = 0;
      for (const file of rows) {
        // Return to the original folder when it still exists; root otherwise.
        let targetFolderId: string | null = null;
        if (file.trashedFromFolderId) {
          const stillThere = await tx
            .select({ id: clientFileFolders.id })
            .from(clientFileFolders)
            .where(
              and(
                eq(clientFileFolders.id, file.trashedFromFolderId),
                eq(clientFileFolders.clientId, args.clientId),
              ),
            )
            .limit(1);
          if (stillThere[0]) targetFolderId = file.trashedFromFolderId;
        }
        const finalName = await findAvailableFileName(
          tx,
          args.clientId,
          targetFolderId,
          file.name,
        );
        await tx
          .update(clientFiles)
          .set({
            trashedAt: null,
            trashedBy: null,
            trashedFromFolderId: null,
            folderId: targetFolderId,
            name: finalName,
            updatedAt: new Date(),
          })
          .where(eq(clientFiles.id, file.id));
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: file.id,
          action: "restored",
          actor: args.actor,
          detail: {
            name: finalName,
            ...(finalName !== file.name ? { renamedFrom: file.name } : {}),
          },
        });
        restored++;
      }
      return { restored };
    });
  });
}

// ── Purge (permanent delete) ───────────────────────────────────────────────

export interface PurgeTarget {
  fileId: string;
  name: string;
  clientId: string;
  /** Current + all version object keys — every byte this file owns. */
  objectKeys: string[];
  totalBytes: number;
}

/** Trashed files only — purge never touches live files. */
export async function listPurgeTargets(
  clientId: string,
  fileIds?: string[],
): Promise<PurgeTarget[]> {
  return withDbAttribution("clientFiles:listPurgeTargets", async () => {
    const dbx = getDb();
    const conds = [eq(clientFiles.clientId, clientId), isNotNull(clientFiles.trashedAt)];
    if (fileIds && fileIds.length > 0) conds.push(inArray(clientFiles.id, fileIds));
    const files = await dbx
      .select()
      .from(clientFiles)
      .where(and(...conds));
    if (files.length === 0) return [];
    const versions = await dbx
      .select({
        fileId: clientFileVersions.fileId,
        objectKey: clientFileVersions.objectKey,
        sizeBytes: clientFileVersions.sizeBytes,
      })
      .from(clientFileVersions)
      .where(inArray(clientFileVersions.fileId, files.map((f) => f.id)));
    const byFile = new Map<string, { keys: string[]; bytes: number }>();
    for (const f of files) byFile.set(f.id, { keys: [f.objectKey], bytes: Number(f.sizeBytes) });
    for (const v of versions) {
      const entry = byFile.get(v.fileId);
      if (entry) {
        entry.keys.push(v.objectKey);
        entry.bytes += Number(v.sizeBytes);
      }
    }
    return files.map((f) => ({
      fileId: f.id,
      name: f.name,
      clientId: f.clientId,
      objectKeys: byFile.get(f.id)!.keys,
      totalBytes: byFile.get(f.id)!.bytes,
    }));
  });
}

/**
 * Remove the DB rows for files whose objects are ALREADY deleted (or
 * confirmed absent). Version + activity rows cascade; a fresh `purged`
 * activity row (fileId NULL — the file row is gone) keeps the client-level
 * trail readable.
 */
export async function purgeFileRows(args: {
  clientId: string;
  files: { fileId: string; name: string; totalBytes: number }[];
  actor: FileActor;
  via?: "manual" | "retention_sweep";
}): Promise<{ purged: number }> {
  return withDbAttribution("clientFiles:purgeFileRows", async () => {
    if (args.files.length === 0) return { purged: 0 };
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const deleted = await tx
        .delete(clientFiles)
        .where(
          and(
            eq(clientFiles.clientId, args.clientId),
            inArray(clientFiles.id, args.files.map((f) => f.fileId)),
            isNotNull(clientFiles.trashedAt),
          ),
        )
        .returning({ id: clientFiles.id });
      const deletedIds = new Set(deleted.map((d) => d.id));
      for (const f of args.files) {
        if (!deletedIds.has(f.fileId)) continue;
        await logActivity(tx, {
          clientId: args.clientId,
          fileId: null,
          action: "purged",
          actor: args.actor,
          detail: {
            name: f.name,
            sizeBytes: f.totalBytes,
            via: args.via ?? "manual",
          },
        });
      }
      return { purged: deleted.length };
    });
  });
}

/** Trashed rows past the retention window, oldest first — sweep input. */
export async function listExpiredTrash(
  retentionDays: number,
  limit: number,
): Promise<PurgeTarget[]> {
  return withDbAttribution("clientFiles:listExpiredTrash", async () => {
    const dbx = getDb();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const files = await dbx
      .select()
      .from(clientFiles)
      .where(and(isNotNull(clientFiles.trashedAt), lt(clientFiles.trashedAt, cutoff)))
      .orderBy(asc(clientFiles.trashedAt))
      .limit(limit);
    if (files.length === 0) return [];
    const versions = await dbx
      .select({
        fileId: clientFileVersions.fileId,
        objectKey: clientFileVersions.objectKey,
        sizeBytes: clientFileVersions.sizeBytes,
      })
      .from(clientFileVersions)
      .where(inArray(clientFileVersions.fileId, files.map((f) => f.id)));
    const byFile = new Map<string, { keys: string[]; bytes: number }>();
    for (const f of files) byFile.set(f.id, { keys: [f.objectKey], bytes: Number(f.sizeBytes) });
    for (const v of versions) {
      const entry = byFile.get(v.fileId);
      if (entry) {
        entry.keys.push(v.objectKey);
        entry.bytes += Number(v.sizeBytes);
      }
    }
    return files.map((f) => ({
      fileId: f.id,
      name: f.name,
      clientId: f.clientId,
      objectKeys: byFile.get(f.id)!.keys,
      totalBytes: byFile.get(f.id)!.bytes,
    }));
  });
}

// ── Versions ───────────────────────────────────────────────────────────────

/**
 * Make a prior version the current content again. SWAP semantics: the
 * current content becomes a NEW version row, the restored version's row is
 * deleted, and the file row points at the restored object key. No bytes are
 * copied and every key still exists exactly once.
 */
export async function restoreVersion(args: {
  clientId: string;
  fileId: string;
  versionId: string;
  actor: FileActor;
}): Promise<ClientFile> {
  return withDbAttribution("clientFiles:restoreVersion", async () => {
    return getDb().transaction(async (tx) => {
      await lockClientFileSpace(tx, args.clientId);
      const fileRows = await tx
        .select()
        .from(clientFiles)
        .where(and(eq(clientFiles.id, args.fileId), eq(clientFiles.clientId, args.clientId)))
        .limit(1);
      const file = fileRows[0];
      if (!file) throw new ClientFileError("not_found", "File not found");
      if (file.trashedAt) {
        throw new ClientFileError("invalid", "Restore the file from Trash first");
      }
      const versionRows = await tx
        .select()
        .from(clientFileVersions)
        .where(
          and(
            eq(clientFileVersions.id, args.versionId),
            eq(clientFileVersions.fileId, file.id),
          ),
        )
        .limit(1);
      const version = versionRows[0];
      if (!version) throw new ClientFileError("not_found", "Version not found");

      const maxRows = await tx
        .select({ n: sql<number>`coalesce(max(${clientFileVersions.versionNumber}), 0)::int` })
        .from(clientFileVersions)
        .where(eq(clientFileVersions.fileId, file.id));
      const nextVersion = (maxRows[0]?.n ?? 0) + 1;
      const now = new Date();

      // Current content → new version row…
      await tx.insert(clientFileVersions).values({
        fileId: file.id,
        clientId: args.clientId,
        versionNumber: nextVersion,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        objectKey: file.objectKey,
        uploadedBy: file.uploadedBy,
        uploadedAt: file.contentUpdatedAt,
      });
      // …restored version row disappears (its key moves onto the file row)…
      await tx.delete(clientFileVersions).where(eq(clientFileVersions.id, version.id));
      // …and the file row now serves the restored content.
      const [updated] = await tx
        .update(clientFiles)
        .set({
          objectKey: version.objectKey,
          mimeType: version.mimeType,
          sizeBytes: version.sizeBytes,
          uploadedBy: version.uploadedBy,
          contentUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(clientFiles.id, file.id))
        .returning();
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: file.id,
        action: "version_restored",
        actor: args.actor,
        detail: {
          name: file.name,
          restoredVersionNumber: version.versionNumber,
          priorVersionNumber: nextVersion,
        },
      });
      return updated;
    });
  });
}

// ── Download log ───────────────────────────────────────────────────────────

export async function logDownload(args: {
  clientId: string;
  fileId: string;
  name: string;
  actor: FileActor;
  disposition: "inline" | "attachment" | "zip";
}): Promise<void> {
  return withDbAttribution("clientFiles:logDownload", async () => {
    await logActivity(getDb(), {
      clientId: args.clientId,
      fileId: args.fileId,
      action: "downloaded",
      actor: args.actor,
      detail: { name: args.name, disposition: args.disposition },
    });
  });
}

// ── External share links (Task #4028) ─────────────────────────────────────

/** Share row minus the token hash — what staff listings/creation return. */
export type ShareLinkPublicRow = Omit<ClientFileShareLink, "tokenHash">;

const shareLinkPublicColumns = {
  id: clientFileShareLinks.id,
  clientId: clientFileShareLinks.clientId,
  fileId: clientFileShareLinks.fileId,
  createdBy: clientFileShareLinks.createdBy,
  createdByName: clientFileShareLinks.createdByName,
  expiresAt: clientFileShareLinks.expiresAt,
  revokedAt: clientFileShareLinks.revokedAt,
  revokedBy: clientFileShareLinks.revokedBy,
  accessCount: clientFileShareLinks.accessCount,
  lastAccessedAt: clientFileShareLinks.lastAccessedAt,
  createdAt: clientFileShareLinks.createdAt,
} as const;

/**
 * Mint a share-link row for a LIVE file. The caller generates the random
 * token and passes only its sha256 hex — this layer never sees raw tokens.
 */
export async function createShareLink(args: {
  clientId: string;
  fileId: string;
  tokenHash: string;
  expiresAt: Date;
  actor: FileActor;
}): Promise<ShareLinkPublicRow> {
  return withDbAttribution("clientFiles:createShareLink", async () => {
    return getDb().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(clientFiles)
        .where(and(eq(clientFiles.id, args.fileId), eq(clientFiles.clientId, args.clientId)))
        .limit(1);
      const file = rows[0];
      if (!file) throw new ClientFileError("not_found", "File not found");
      if (file.trashedAt) {
        throw new ClientFileError("invalid", "Cannot share a trashed file");
      }
      const [share] = await tx
        .insert(clientFileShareLinks)
        .values({
          clientId: args.clientId,
          fileId: args.fileId,
          tokenHash: args.tokenHash,
          createdBy: args.actor.id,
          createdByName: args.actor.name,
          expiresAt: args.expiresAt,
        })
        .returning(shareLinkPublicColumns);
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: args.fileId,
        action: "shared",
        actor: args.actor,
        detail: { name: file.name, expiresAt: args.expiresAt.toISOString() },
      });
      return share;
    });
  });
}

/** All links for one file, newest first (revoked/expired included). */
export async function listShareLinks(
  clientId: string,
  fileId: string,
): Promise<ShareLinkPublicRow[]> {
  return withDbAttribution("clientFiles:listShareLinks", async () => {
    return getDb()
      .select(shareLinkPublicColumns)
      .from(clientFileShareLinks)
      .where(
        and(
          eq(clientFileShareLinks.fileId, fileId),
          eq(clientFileShareLinks.clientId, clientId),
        ),
      )
      .orderBy(desc(clientFileShareLinks.createdAt));
  });
}

/** Revoke a link (idempotent: already-revoked returns the row unchanged). */
export async function revokeShareLink(args: {
  clientId: string;
  fileId: string;
  shareId: string;
  actor: FileActor;
}): Promise<ShareLinkPublicRow> {
  return withDbAttribution("clientFiles:revokeShareLink", async () => {
    return getDb().transaction(async (tx) => {
      const rows = await tx
        .select(shareLinkPublicColumns)
        .from(clientFileShareLinks)
        .where(
          and(
            eq(clientFileShareLinks.id, args.shareId),
            eq(clientFileShareLinks.fileId, args.fileId),
            eq(clientFileShareLinks.clientId, args.clientId),
          ),
        )
        .limit(1);
      const share = rows[0];
      if (!share) throw new ClientFileError("not_found", "Share link not found");
      if (share.revokedAt) return share;
      const [updated] = await tx
        .update(clientFileShareLinks)
        .set({ revokedAt: new Date(), revokedBy: args.actor.id })
        .where(eq(clientFileShareLinks.id, share.id))
        .returning(shareLinkPublicColumns);
      const fileRows = await tx
        .select({ name: clientFiles.name })
        .from(clientFiles)
        .where(eq(clientFiles.id, args.fileId))
        .limit(1);
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: args.fileId,
        action: "share_revoked",
        actor: args.actor,
        detail: { name: fileRows[0]?.name ?? "" },
      });
      return updated;
    });
  });
}

/**
 * Task #4040 — replace an ACTIVE link in one step: revoke the old row and
 * mint a fresh one (new token hash, same expiry instant) in a single
 * transaction. Raw tokens are unrecoverable (only sha256 is stored), so this
 * is how staff re-copy a link they've lost without extending its lifetime.
 */
export async function replaceShareLink(args: {
  clientId: string;
  fileId: string;
  shareId: string;
  tokenHash: string;
  actor: FileActor;
}): Promise<ShareLinkPublicRow> {
  return withDbAttribution("clientFiles:replaceShareLink", async () => {
    return getDb().transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(clientFileShareLinks)
        .where(
          and(
            eq(clientFileShareLinks.id, args.shareId),
            eq(clientFileShareLinks.fileId, args.fileId),
            eq(clientFileShareLinks.clientId, args.clientId),
          ),
        )
        .limit(1);
      const old = rows[0];
      if (!old) throw new ClientFileError("not_found", "Share link not found");
      if (old.revokedAt || old.expiresAt.getTime() <= Date.now()) {
        throw new ClientFileError(
          "invalid",
          "Only an active link can be replaced — create a new one instead",
        );
      }
      const fileRows = await tx
        .select()
        .from(clientFiles)
        .where(and(eq(clientFiles.id, args.fileId), eq(clientFiles.clientId, args.clientId)))
        .limit(1);
      const file = fileRows[0];
      if (!file) throw new ClientFileError("not_found", "File not found");
      if (file.trashedAt) {
        throw new ClientFileError("invalid", "Cannot share a trashed file");
      }
      // Concurrency guard: claim the old row conditionally — only one of two
      // simultaneous replace calls can flip revoked_at from NULL, so exactly
      // one replacement is minted; the loser gets the "not active" error.
      const claimed = await tx
        .update(clientFileShareLinks)
        .set({ revokedAt: new Date(), revokedBy: args.actor.id })
        .where(
          and(
            eq(clientFileShareLinks.id, old.id),
            isNull(clientFileShareLinks.revokedAt),
            gt(clientFileShareLinks.expiresAt, new Date()),
          ),
        )
        .returning({ id: clientFileShareLinks.id });
      if (claimed.length !== 1) {
        throw new ClientFileError(
          "invalid",
          "Only an active link can be replaced — create a new one instead",
        );
      }
      const [fresh] = await tx
        .insert(clientFileShareLinks)
        .values({
          clientId: args.clientId,
          fileId: args.fileId,
          tokenHash: args.tokenHash,
          createdBy: args.actor.id,
          createdByName: args.actor.name,
          // Same expiry instant as the link it replaces — replacement is a
          // re-copy affordance, never a silent lifetime extension.
          expiresAt: old.expiresAt,
        })
        .returning(shareLinkPublicColumns);
      await logActivity(tx, {
        clientId: args.clientId,
        fileId: args.fileId,
        action: "share_replaced",
        actor: args.actor,
        detail: { name: file.name, expiresAt: old.expiresAt.toISOString() },
      });
      return fresh;
    });
  });
}

export interface ResolvedShare {
  share: ClientFileShareLink;
  file: ClientFile;
}

/** Look up a share + its file by token hash. Existence only — the caller
 * applies the expiry/revocation/trash gate. */
export async function getShareByTokenHash(
  tokenHash: string,
): Promise<ResolvedShare | null> {
  return withDbAttribution("clientFiles:getShareByTokenHash", async () => {
    const rows = await getDb()
      .select({ share: clientFileShareLinks, file: clientFiles })
      .from(clientFileShareLinks)
      .innerJoin(clientFiles, eq(clientFileShareLinks.fileId, clientFiles.id))
      .where(eq(clientFileShareLinks.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** Count a successful external download against the link + activity feed. */
export async function recordShareAccess(args: {
  shareId: string;
  clientId: string;
  fileId: string;
  fileName: string;
}): Promise<void> {
  return withDbAttribution("clientFiles:recordShareAccess", async () => {
    const dbx = getDb();
    await dbx
      .update(clientFileShareLinks)
      .set({
        accessCount: sql`${clientFileShareLinks.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(clientFileShareLinks.id, args.shareId));
    await logActivity(dbx, {
      clientId: args.clientId,
      fileId: args.fileId,
      action: "downloaded",
      actor: { id: null, name: "External share link" },
      detail: { name: args.fileName, disposition: "attachment", via: "share_link" },
    });
  });
}

// ── Usage rollups ──────────────────────────────────────────────────────────

export interface ClientFileUsage {
  liveCount: number;
  liveBytes: number;
  versionCount: number;
  versionBytes: number;
  trashCount: number;
  trashBytes: number;
  totalBytes: number;
}

export async function clientUsage(clientId: string): Promise<ClientFileUsage> {
  return withDbAttribution("clientFiles:clientUsage", async () => {
    const dbx = getDb();
    const [fileAgg, versionAgg] = await Promise.all([
      dbx
        .select({
          liveCount: sql<number>`count(*) FILTER (WHERE trashed_at IS NULL)::int`,
          liveBytes: sql<string>`coalesce(sum(size_bytes) FILTER (WHERE trashed_at IS NULL), 0)`,
          trashCount: sql<number>`count(*) FILTER (WHERE trashed_at IS NOT NULL)::int`,
          trashBytes: sql<string>`coalesce(sum(size_bytes) FILTER (WHERE trashed_at IS NOT NULL), 0)`,
        })
        .from(clientFiles)
        .where(eq(clientFiles.clientId, clientId)),
      dbx
        .select({
          versionCount: sql<number>`count(*)::int`,
          versionBytes: sql<string>`coalesce(sum(size_bytes), 0)`,
        })
        .from(clientFileVersions)
        .where(eq(clientFileVersions.clientId, clientId)),
    ]);
    const f = fileAgg[0];
    const v = versionAgg[0];
    const liveBytes = Number(f?.liveBytes ?? 0);
    const trashBytes = Number(f?.trashBytes ?? 0);
    const versionBytes = Number(v?.versionBytes ?? 0);
    return {
      liveCount: f?.liveCount ?? 0,
      liveBytes,
      versionCount: v?.versionCount ?? 0,
      versionBytes,
      trashCount: f?.trashCount ?? 0,
      trashBytes,
      totalBytes: liveBytes + trashBytes + versionBytes,
    };
  });
}

export interface PerClientUsageRow {
  clientId: string;
  firmName: string;
  liveCount: number;
  liveBytes: number;
  versionBytes: number;
  trashBytes: number;
  totalBytes: number;
}

export async function allClientsUsage(): Promise<{
  clients: PerClientUsageRow[];
  totals: { clients: number; liveCount: number; totalBytes: number };
}> {
  return withDbAttribution("clientFiles:allClientsUsage", async () => {
    const result = await getDb().execute(sql`
      WITH file_agg AS (
        SELECT client_id,
               count(*) FILTER (WHERE trashed_at IS NULL)::int AS live_count,
               coalesce(sum(size_bytes) FILTER (WHERE trashed_at IS NULL), 0) AS live_bytes,
               coalesce(sum(size_bytes) FILTER (WHERE trashed_at IS NOT NULL), 0) AS trash_bytes
        FROM client_files GROUP BY client_id
      ), version_agg AS (
        SELECT client_id, coalesce(sum(size_bytes), 0) AS version_bytes
        FROM client_file_versions GROUP BY client_id
      )
      SELECT c.id AS client_id, c.firm_name,
             coalesce(f.live_count, 0) AS live_count,
             coalesce(f.live_bytes, 0) AS live_bytes,
             coalesce(v.version_bytes, 0) AS version_bytes,
             coalesce(f.trash_bytes, 0) AS trash_bytes
      FROM clients c
      LEFT JOIN file_agg f ON f.client_id = c.id
      LEFT JOIN version_agg v ON v.client_id = c.id
      WHERE coalesce(f.live_count, 0) > 0
         OR coalesce(f.trash_bytes, 0) > 0
         OR coalesce(v.version_bytes, 0) > 0
      ORDER BY (coalesce(f.live_bytes, 0) + coalesce(v.version_bytes, 0) + coalesce(f.trash_bytes, 0)) DESC
    `);
    const rows = (result as any).rows as any[];
    const clientRows: PerClientUsageRow[] = rows.map((r) => ({
      clientId: r.client_id,
      firmName: r.firm_name,
      liveCount: Number(r.live_count),
      liveBytes: Number(r.live_bytes),
      versionBytes: Number(r.version_bytes),
      trashBytes: Number(r.trash_bytes),
      totalBytes: Number(r.live_bytes) + Number(r.version_bytes) + Number(r.trash_bytes),
    }));
    return {
      clients: clientRows,
      totals: {
        clients: clientRows.length,
        liveCount: clientRows.reduce((a, r) => a + r.liveCount, 0),
        totalBytes: clientRows.reduce((a, r) => a + r.totalBytes, 0),
      },
    };
  });
}

/** Storage keys referenced by ANY file/version row — the abandoned-upload
 * sweep must never delete these. */
export async function listReferencedObjectKeys(): Promise<Set<string>> {
  return withDbAttribution("clientFiles:listReferencedObjectKeys", async () => {
    const dbx = getDb();
    const [fileKeys, versionKeys] = await Promise.all([
      dbx.select({ k: clientFiles.objectKey }).from(clientFiles),
      dbx.select({ k: clientFileVersions.objectKey }).from(clientFileVersions),
    ]);
    const set = new Set<string>();
    for (const r of fileKeys) set.add(r.k);
    for (const r of versionKeys) set.add(r.k);
    return set;
  });
}

export async function findLiveFileByName(
  clientId: string,
  folderId: string | null,
  name: string,
): Promise<ClientFile | null> {
  return withDbAttribution("clientFiles:findLiveFileByName", async () => {
    const rows = await getDb()
      .select()
      .from(clientFiles)
      .where(
        and(
          eq(clientFiles.clientId, clientId),
          folderId ? eq(clientFiles.folderId, folderId) : isNull(clientFiles.folderId),
          isNull(clientFiles.trashedAt),
          sql`lower(${clientFiles.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}
