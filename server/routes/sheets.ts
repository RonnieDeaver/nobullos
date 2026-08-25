/**
 * NoBull Sheets — workbook & folder CRUD routes + version history & restore, plus edit-locking.
 *
 * All endpoints are gated by `isAuthenticated`. Any authenticated role
 * (account_manager and above) may create workbooks/folders; the snapshot
 * size guard rejects payloads over SNAPSHOT_MAX_BYTES.
 *
 * Permission model (enforced per-request):
 *   - CEO role sees and can manage everything (owner-equivalent).
 *   - Listing: returns workbooks the caller owns OR has an explicit
 *     permission row OR has a role grant for.
 *   - Read snapshot: owner/CEO or any permission/role-grant.
 *   - Write snapshot / rename / move: owner/CEO or editor permission/role-grant.
 *   - Delete workbook: owner or CEO only.
 *   - Permission management (user + role grants): owner or CEO only.
 *   - Folders: owner only (create / rename / delete).
 *   - Version history: readable by anyone with access to the workbook.
 *   - Save manual version / restore: write permission required (editor+).
 *
 * Edit-locking:
 *   POST   /api/sheets/workbooks/:id/lock            — acquire
 *   POST   /api/sheets/workbooks/:id/lock/heartbeat  — renew
 *   DELETE /api/sheets/workbooks/:id/lock            — release
 *   GET    /api/sheets/workbooks/:id/lock            — poll current holder
 *
 * Snapshot saves now require:
 *   - The caller to hold the current lock (429 LOCK_REQUIRED otherwise).
 *   - A matching `expectedRevision` body field (409 REVISION_CONFLICT otherwise).
 *   - Data blocks: write workbook permission required.
 *
 * Each GET /api/sheets/workbooks/:id response includes a `userPermission`
 * field ("owner" | "editor" | "viewer") so the client can render the
 * appropriate UI mode.
 */
import type { Express } from "express";
import { z } from "zod";
import { isAuthenticated } from "../middlewares/requireAuth";
import { requireAccountManager, writeLimiter, sheetsAutosaveLimiter, sheetsImportUpload, uploadLimiter } from "./middleware";
import { storage } from "../storage";
import { workbookPermissionRoleOptions, workbookRoleGrantAccessLevels } from "@shared/schema";
import { listConnectors } from "../services/sheetsConnectors";
import { enqueueSheetDataBlockRefresh } from "../services/sheetsDataRefresh";
import { convertToUniverSnapshot, normalizeSnapshotColors, IMPORT_MAX_FILE_BYTES } from "../services/sheetsImportConverter";
import { isKillSwitchEnabled } from "../services/killSwitches";
import { convertSnapshotToXlsx, convertSheetToCsv, findSheet } from "../services/sheetsExportConverter";

const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Warn the client when the snapshot reaches 80 % of the hard cap so they
// have time to split the workbook before hitting the server limit.
const SNAPSHOT_WARN_BYTES = Math.floor(SNAPSHOT_MAX_BYTES * 0.8);

function snapshotBytes(snapshot: unknown): number {
  if (snapshot === undefined || snapshot === null) return 0;
  return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

/** Extract the caller's DB user role from the request (set by requireAccountManager). */
function callerRole(req: any): string | undefined {
  return req.dbUser?.role as string | undefined;
}

/** Build a display name for the activity log from the authenticated request. */
function callerDisplayName(req: any): string {
  const db = req.dbUser;
  if (db) {
    const full = [db.firstName, db.lastName].filter(Boolean).join(" ").trim();
    if (full) return full;
    if (db.email) return db.email;
  }
  return req.user?.claims?.sub ?? "Unknown";
}

/** Fire-and-forget wrapper for activity logging — never throws. */
function logActivity(params: {
  workbookId: string;
  actorId: string;
  actorName: string;
  action: import("@shared/schema").SheetActivityAction;
  detail?: Record<string, unknown> | null;
}): void {
  storage.logSheetActivity(params).catch((err: any) =>
    console.warn("[sheets] logActivity error:", err?.message ?? err),
  );
}

/**
 * Check the `sheets_writes_disabled` kill switch. Returns true when writes
 * are blocked (caller should respond 503). Reads are never affected.
 */
function writesDisabled(): boolean {
  return isKillSwitchEnabled("sheets_writes_disabled");
}

export function registerSheetsRoutes(app: Express): void {
  // ---- Folders ----

  app.get(
    "/api/sheets/folders",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const folders = await storage.listSheetFolders(userId);
        res.json({ folders });
      } catch (err: any) {
        console.error("[sheets] listFolders failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list folders" });
      }
    },
  );

  app.post(
    "/api/sheets/folders",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const body = z.object({ name: z.string().min(1).max(255) }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const folder = await storage.createSheetFolder({ name: body.data.name, ownerId: userId });
        res.status(201).json({ folder });
      } catch (err: any) {
        console.error("[sheets] createFolder failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to create folder" });
      }
    },
  );

  app.patch(
    "/api/sheets/folders/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const folder = await storage.getSheetFolder(req.params.id);
        if (!folder) return res.status(404).json({ error: "Folder not found" });
        if (folder.ownerId !== userId) return res.status(403).json({ error: "Forbidden" });

        const body = z.object({ name: z.string().min(1).max(255) }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const updated = await storage.updateSheetFolder(req.params.id, { name: body.data.name });
        res.json({ folder: updated });
      } catch (err: any) {
        console.error("[sheets] updateFolder failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update folder" });
      }
    },
  );

  app.delete(
    "/api/sheets/folders/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const folder = await storage.getSheetFolder(req.params.id);
        if (!folder) return res.status(404).json({ error: "Folder not found" });
        if (folder.ownerId !== userId) return res.status(403).json({ error: "Forbidden" });
        await storage.deleteSheetFolder(req.params.id);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deleteFolder failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete folder" });
      }
    },
  );

  // ---- Workbooks ----

  const createWorkbookSchema = z.object({
    name: z.string().min(1).max(255),
    folderId: z.string().optional().nullable(),
    snapshot: z.unknown().optional(),
  });

  const updateWorkbookSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    folderId: z.string().nullable().optional(),
    snapshot: z.unknown().optional(),
    expectedRevision: z.number().int().min(0).optional(),
  });

  // Task #4488 — server-side pagination/search/sort for the library table.
  // All params optional; omitting `limit` keeps the legacy full-list shape.
  const listWorkbooksQuerySchema = z.object({
    folderId: z.string().optional(),
    q: z.string().trim().max(300).optional(),
    sort: z.enum(["name", "folder", "owner", "updated", "activity"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  });

  app.get(
    "/api/sheets/workbooks",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const query = listWorkbooksQuerySchema.safeParse(req.query);
        if (!query.success) {
          return res.status(400).json({ error: "Invalid list parameters" });
        }
        const { folderId, q, sort, dir, limit, offset } = query.data;
        // listSheetWorkbooksPage already excludes the snapshot column at
        // the DB level — no JS-side strip needed. Task #4488: pagination,
        // search and sort run server-side; `total` drives the client pager.
        // Without `limit` the full list returns (back-compat consumers).
        const { workbooks, total } = await storage.listSheetWorkbooksPage({
          userId,
          userRole,
          folderId: folderId === "null" ? null : folderId,
          q,
          sort,
          dir,
          limit,
          offset,
        });
        res.json({ workbooks, total });
      } catch (err: any) {
        console.error("[sheets] listWorkbooks failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list workbooks" });
      }
    },
  );

  /**
   * GET /api/sheets/workbooks/last-activity
   * Query: { ids: comma-separated workbook IDs }
   * Permission: any authenticated account_manager+ (callers only pass their own IDs).
   * IMPORTANT: must be registered BEFORE the /:id route so Express matches
   * the literal segment "last-activity" first (registration order wins).
   */
  app.get(
    "/api/sheets/workbooks/last-activity",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const raw = typeof req.query.ids === "string" ? req.query.ids : "";
        const ids = raw.split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 200);
        if (ids.length === 0) return res.json({ lastActivity: {} });

        const map = await storage.getSheetWorkbookLastActivityMap(ids);
        const lastActivity: Record<string, string> = {};
        for (const [id, date] of map) {
          lastActivity[id] = date.toISOString();
        }
        res.json({ lastActivity });
      } catch (err: any) {
        console.error("[sheets] lastActivity failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get last activity" });
      }
    },
  );

  // Get a single workbook (with snapshot). Includes `userPermission` field.
  app.get(
    "/api/sheets/workbooks/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const accessLevel = await storage.getWorkbookAccessLevel(req.params.id, userId, userRole);
        if (!accessLevel) return res.status(403).json({ error: "Forbidden" });
        // Self-heal snapshots imported before the #-prefix color fix so existing
        // workbooks render correctly without a manual re-import.
        const normalizedWorkbook = workbook.snapshot
          ? { ...workbook, snapshot: normalizeSnapshotColors(workbook.snapshot) }
          : workbook;
        res.json({ workbook: normalizedWorkbook, userPermission: accessLevel });
      } catch (err: any) {
        console.error("[sheets] getWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get workbook" });
      }
    },
  );

  app.post(
    "/api/sheets/workbooks",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const body = createWorkbookSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const { name, folderId, snapshot } = body.data;
        if (snapshot !== undefined && snapshotBytes(snapshot) > SNAPSHOT_MAX_BYTES) {
          return res.status(413).json({ error: "Snapshot exceeds 10 MB limit" });
        }
        const workbook = await storage.createSheetWorkbook({
          name,
          folderId: folderId ?? null,
          ownerId: userId,
          snapshot: snapshot !== undefined ? (snapshot as any) : null,
        });
        logActivity({
          workbookId: workbook.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "created",
          detail: { name },
        });
        res.status(201).json({ workbook });
      } catch (err: any) {
        console.error("[sheets] createWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to create workbook" });
      }
    },
  );

  // Update a workbook (name / folder / snapshot).
  // When a snapshot is included:
  //   • The caller must hold the edit lock (else 423 LOCK_REQUIRED).
  //   • `expectedRevision` must match the stored revision (else 409 REVISION_CONFLICT).
  //   • An auto-version is captured if enough time has passed since the last version (5-minute cadence gate).
  // Uses sheetsAutosave limiter (200/15 min) rather than writeLimiter because
  // autosave can fire every ~30 s from the editor (background-style traffic).
  app.patch(
    "/api/sheets/workbooks/:id",
    isAuthenticated,
    requireAccountManager,
    sheetsAutosaveLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        const canWrite = await storage.canUserWriteWorkbook(req.params.id, userId, userRole);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });

        const body = updateWorkbookSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const patch = body.data;

        // ---- snapshot save path: enforce lock + revision ----
        if (patch.snapshot !== undefined) {
          if (snapshotBytes(patch.snapshot) > SNAPSHOT_MAX_BYTES) {
            return res.status(413).json({ error: "Snapshot exceeds 10 MB limit" });
          }

          // Belt-and-braces: caller must hold the edit lock.
          const lock = await storage.getWorkbookLock(req.params.id);
          if (lock && lock.holderUserId !== userId) {
            return res.status(423).json({
              error: "LOCK_REQUIRED",
              message: `${lock.holderName} is currently editing this workbook`,
              lock: serializeLock(lock),
            });
          }

          // Revision guard: `expectedRevision` required when snapshot is provided.
          if (patch.expectedRevision === undefined) {
            return res.status(400).json({
              error: "MISSING_REVISION",
              message: "expectedRevision is required when saving a snapshot",
            });
          }

          // Capture auto-version before overwriting (fire-and-forget; doesn't block response).
          storage.captureAutoVersion({
            workbookId: req.params.id,
            snapshot: patch.snapshot,
            createdBy: userId,
          }).catch((err: any) =>
            console.warn("[sheets] captureAutoVersion failed:", err?.message ?? err),
          );

          const result = await storage.saveSheetWorkbookSnapshot(
            req.params.id,
            patch.snapshot,
            patch.expectedRevision,
          );

          if (!result.ok) {
            return res.status(409).json({
              error: "REVISION_CONFLICT",
              message: "This workbook was modified by another session. Reload to continue.",
              currentRevision: result.currentRevision,
            });
          }

          // Warn the client when the snapshot is approaching the cap so the
          // user has time to split the workbook before hitting the hard limit.
          const savedBytes = snapshotBytes(patch.snapshot);
          if (savedBytes >= SNAPSHOT_WARN_BYTES) {
            res.setHeader(
              "X-Snapshot-Size-Warning",
              `${savedBytes} bytes — approaching the 10 MB limit. Consider splitting this workbook.`,
            );
          }

          // Apply any non-snapshot fields (name, folderId) if also provided.
          let finalWorkbook = result.workbook;
          const metaPatch: Record<string, unknown> = {};
          if (patch.name !== undefined) metaPatch.name = patch.name;
          if (patch.folderId !== undefined) metaPatch.folderId = patch.folderId;
          if (Object.keys(metaPatch).length > 0) {
            finalWorkbook =
              (await storage.updateSheetWorkbook(req.params.id, metaPatch as any)) ??
              finalWorkbook;
          }

          return res.json({ workbook: finalWorkbook });
        }

        // ---- metadata-only update (name / folderId) ----
        const updated = await storage.updateSheetWorkbook(req.params.id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        });
        if (patch.name !== undefined && patch.name !== workbook.name) {
          logActivity({
            workbookId: req.params.id,
            actorId: userId,
            actorName: callerDisplayName(req),
            action: "renamed",
            detail: { oldName: workbook.name, newName: patch.name },
          });
        }
        res.json({ workbook: updated });
      } catch (err: any) {
        console.error("[sheets] updateWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update workbook" });
      }
    },
  );

  // Delete a workbook (owner or CEO only). Versions cascade via FK.
  app.delete(
    "/api/sheets/workbooks/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const isCeo = userRole === "ceo";
        if (!isCeo && workbook.ownerId !== userId) {
          return res.status(403).json({ error: "Forbidden — owner only" });
        }
        await storage.deleteSheetWorkbook(req.params.id);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deleteWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete workbook" });
      }
    },
  );

  // ---- Edit-locking ----

  const acquireLockSchema = z.object({
    holderName: z.string().min(1).max(255),
  });

  /**
   * Acquire (or re-acquire) the edit lock.
   * Body: { holderName: string }
   * Response:
   *   200 { acquired: true,  lock }          — caller now holds the lock
   *   200 { acquired: false, lock }          — another user holds a live lock
   */
  app.post(
    "/api/sheets/workbooks/:id/lock",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        const canWrite = await storage.canUserWriteWorkbook(req.params.id, userId, userRole);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });

        const body = acquireLockSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const result = await storage.acquireWorkbookLock(
          req.params.id,
          userId,
          body.data.holderName,
        );
        res.json({ acquired: result.acquired, lock: serializeLock(result.lock) });
      } catch (err: any) {
        console.error("[sheets] acquireLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to acquire lock" });
      }
    },
  );

  /**
   * Renew a held lock's heartbeat.
   * Returns 200 { lock } if still held, 409 if the lock was lost.
   */
  app.post(
    "/api/sheets/workbooks/:id/lock/heartbeat",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        const lock = await storage.heartbeatWorkbookLock(req.params.id, userId);
        if (!lock) {
          return res.status(409).json({
            error: "LOCK_LOST",
            message: "Your edit lock has expired or was taken over",
          });
        }
        res.json({ lock: serializeLock(lock) });
      } catch (err: any) {
        console.error("[sheets] heartbeatLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to renew lock" });
      }
    },
  );

  /**
   * Release the edit lock.
   * Silently succeeds even if the lock is already gone.
   */
  app.delete(
    "/api/sheets/workbooks/:id/lock",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        // Read the lock before releasing so we can compute session duration.
        const lockBeforeRelease = await storage.getWorkbookLock(req.params.id);
        const isOwnLock = lockBeforeRelease?.holderUserId === userId;
        const durationMs = isOwnLock && lockBeforeRelease?.acquiredAt
          ? Date.now() - new Date(lockBeforeRelease.acquiredAt).getTime()
          : null;

        await storage.releaseWorkbookLock(req.params.id, userId);

        if (isOwnLock) {
          logActivity({
            workbookId: req.params.id,
            actorId: userId,
            actorName: callerDisplayName(req),
            action: "edited",
            detail: durationMs != null ? { duration_ms: durationMs } : null,
          });
        }

        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] releaseLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to release lock" });
      }
    },
  );

  /**
   * Poll the current lock state.
   * Returns 200 { locked: false } or 200 { locked: true, lock }.
   */
  app.get(
    "/api/sheets/workbooks/:id/lock",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId, userRole);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        const lock = await storage.getWorkbookLock(req.params.id);
        if (!lock) return res.json({ locked: false });
        res.json({ locked: true, lock: serializeLock(lock) });
      } catch (err: any) {
        console.error("[sheets] getLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get lock" });
      }
    },
  );

  // ---- Workbook user-level permissions ----

  const upsertPermSchema = z.object({
    userId: z.string().min(1),
    role: z.enum(workbookPermissionRoleOptions),
  });

  /** Check if caller is owner or CEO (allowed to manage permissions). */
  async function isOwnerOrCeo(workbookId: string, callerId: string, callerRoleStr?: string): Promise<boolean> {
    if (callerRoleStr === "ceo") return true;
    const workbook = await storage.getSheetWorkbook(workbookId);
    return workbook?.ownerId === callerId;
  }

  // List user permissions for a workbook (owner or CEO only).
  app.get(
    "/api/sheets/workbooks/:id/permissions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const permissions = await storage.listSheetWorkbookPermissions(req.params.id);
        res.json({ permissions });
      } catch (err: any) {
        console.error("[sheets] listPermissions failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list permissions" });
      }
    },
  );

  // Grant / update a user permission (owner or CEO only).
  app.put(
    "/api/sheets/workbooks/:id/permissions",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const body = upsertPermSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const { userId, role } = body.data;
        const permission = await storage.upsertSheetWorkbookPermission({
          workbookId: req.params.id,
          userId,
          role,
          grantedBy: callerId,
        });
        logActivity({
          workbookId: req.params.id,
          actorId: callerId,
          actorName: callerDisplayName(req),
          action: "shared",
          detail: { targetUserId: userId, role },
        });
        res.json({ permission });
      } catch (err: any) {
        console.error("[sheets] upsertPermission failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update permission" });
      }
    },
  );

  // Revoke a user permission (owner or CEO only).
  app.delete(
    "/api/sheets/workbooks/:id/permissions/:userId",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        await storage.deleteSheetWorkbookPermission(req.params.id, req.params.userId);
        logActivity({
          workbookId: req.params.id,
          actorId: callerId,
          actorName: callerDisplayName(req),
          action: "unshared",
          detail: { targetUserId: req.params.userId },
        });
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deletePermission failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete permission" });
      }
    },
  );

  // ---- Import from XLSX / CSV ----

  /**
   * POST /api/sheets/workbooks/import
   *
   * Multipart upload. Fields:
   *   - `file`       : the .xlsx / .csv file (required)
   *   - `name`       : workbook name override (optional; defaults to filename without extension)
   *   - `folderId`   : folder to place the new workbook in (optional)
   *
   * Returns:
   *   201 { workbook, report }   — workbook created, report describes what was skipped
   *   400                        — bad request / missing file
   *   413                        — file too large
   *   415                        — unsupported file type
   *   422                        — malformed/unreadable file
   *   500                        — unexpected server error
   *
   * DB-hold rule: conversion (XLSX parse + snapshot build) completes BEFORE
   * any DB write. The DB write is a single INSERT via storage.createSheetWorkbook.
   */
  app.post(
    "/api/sheets/workbooks/import",
    isAuthenticated,
    requireAccountManager,
    uploadLimiter,
    (req, res, next) => {
      sheetsImportUpload.single("file")(req, res, (err) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              error: "File too large",
              message: `The file must be under ${Math.round(IMPORT_MAX_FILE_BYTES / 1024 / 1024)} MB.`,
            });
          }
          return res.status(415).json({
            error: "Unsupported file type",
            message: err.message ?? "Only .xlsx, .xls, .csv, and .tsv files are supported.",
          });
        }
        next();
      });
    },
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;

        if (!req.file) {
          return res.status(400).json({
            error: "No file uploaded",
            message: "Please include a file field named 'file'.",
          });
        }

        const originalName: string = req.file.originalname ?? "import";
        const baseName = originalName.replace(/\.[^.]+$/, "").trim() || "Imported Workbook";

        const bodyName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        const workbookName = (bodyName || baseName).slice(0, 255);

        const folderId: string | null =
          typeof req.body?.folderId === "string" && req.body.folderId
            ? req.body.folderId
            : null;

        // ── Convert (no DB hold) ───────────────────────────────────────────────
        let convResult;
        try {
          convResult = await convertToUniverSnapshot(
            req.file.buffer,
            originalName,
            workbookName,
          );
        } catch (convErr: any) {
          return res.status(422).json({
            error: "Import failed",
            message: convErr?.message ?? "The file could not be converted.",
          });
        }

        const { snapshot, report } = convResult;

        // Snapshot size guard (same limit as manual saves).
        const snapBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
        if (snapBytes > SNAPSHOT_MAX_BYTES) {
          return res.status(413).json({
            error: "Converted workbook too large",
            message: `The resulting workbook is ${Math.round(snapBytes / 1024 / 1024)} MB, which exceeds the 10 MB limit. Try importing fewer sheets or rows.`,
          });
        }

        // ── DB write (snapshot fully built before entering hold) ───────────────
        const workbook = await storage.createSheetWorkbook({
          name: workbookName,
          folderId,
          ownerId: userId,
          snapshot: snapshot as any,
        });

        logActivity({
          workbookId: workbook.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "imported",
          detail: { source: "file", originalName, format: originalName.split(".").pop() ?? "unknown" },
        });
        res.status(201).json({ workbook, report });
      } catch (err: any) {
        console.error("[sheets] importWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Import failed due to a server error." });
      }
    },
  );


  // ---- Export ----

  /**
   * GET /api/sheets/workbooks/:id/export/xlsx
   *
   * Download the entire workbook as an .xlsx file.
   * Permission: any role that can access (view) the workbook may export.
   *
   * The snapshot is fetched from DB (no DB hold across conversion — conversion
   * happens in memory after the fetch completes).
   */
  app.get(
    "/api/sheets/workbooks/:id/export/xlsx",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        if (!workbook.snapshot) {
          return res.status(422).json({ error: "This workbook has no content to export." });
        }

        let xlsxBuf: Buffer;
        try {
          xlsxBuf = await convertSnapshotToXlsx(
            workbook.snapshot as any,
            workbook.name,
          );
        } catch (convErr: any) {
          return res.status(422).json({
            error: "Export failed",
            message: convErr?.message ?? "The workbook could not be converted.",
          });
        }

        const safeName = workbook.name.replace(/[^\w\s-]/g, "").trim() || "workbook";
        logActivity({
          workbookId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "exported",
          detail: { format: "xlsx" },
        });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.xlsx"`);
        res.setHeader("Content-Length", xlsxBuf.length);
        res.send(xlsxBuf);
      } catch (err: any) {
        console.error("[sheets] exportXlsx failed:", err?.message ?? err);
        res.status(500).json({ error: "Export failed due to a server error." });
      }
    },
  );

  /**
   * GET /api/sheets/workbooks/:id/sheets/:sheetId/export/csv
   *
   * Download a single sheet tab as a .csv file.
   * Permission: any role that can access (view) the workbook may export.
   */
  app.get(
    "/api/sheets/workbooks/:id/sheets/:sheetId/export/csv",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        if (!workbook.snapshot) {
          return res.status(422).json({ error: "This workbook has no content to export." });
        }

        const snapshot = workbook.snapshot as any;
        const sheet = findSheet(snapshot, req.params.sheetId);
        if (!sheet) {
          return res.status(404).json({ error: "Sheet tab not found in this workbook." });
        }

        let csvContent: string;
        try {
          csvContent = convertSheetToCsv(sheet);
        } catch (convErr: any) {
          return res.status(422).json({
            error: "CSV export failed",
            message: convErr?.message ?? "The sheet could not be converted to CSV.",
          });
        }

        const safeWbName = workbook.name.replace(/[^\w\s-]/g, "").trim() || "workbook";
        const safeSheetName = sheet.name.replace(/[^\w\s-]/g, "").trim() || req.params.sheetId;
        const filename = `${safeWbName} - ${safeSheetName}`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}.csv"`);
        res.send(csvContent);
      } catch (err: any) {
        console.error("[sheets] exportCsv failed:", err?.message ?? err);
        res.status(500).json({ error: "Export failed due to a server error." });
      }
    },
  );

  // ---- Data block connectors ----

  // List available connectors.
  app.get(
    "/api/sheets/connectors",
    isAuthenticated,
    requireAccountManager,
    (_req, res) => {
      try {
        res.json({ connectors: listConnectors() });
      } catch (err: any) {
        console.error("[sheets] listConnectors failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list connectors" });
      }
    },
  );

  // ---- Data blocks ----

  const insertBlockSchema = z.object({
    label: z.string().min(1).max(255),
    connectorId: z.string().min(1),
    connectorParams: z.record(z.unknown()).default({}),
    sheetId: z.string().min(1),
    startRow: z.number().int().min(0).default(0),
    startCol: z.number().int().min(0).default(0),
    autoRefresh: z.boolean().default(false),
  });

  // ---- Version history & restore ----

  // List versions (metadata only, no snapshot body) — any reader.
  app.get(
    "/api/sheets/workbooks/:id/versions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });
        const versions = await storage.listSheetWorkbookVersions(req.params.id);
        res.json({ versions });
      } catch (err: any) {
        console.error("[sheets] listVersions failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list versions" });
      }
    },
  );

  // Get a specific version including its snapshot — any reader.
  app.get(
    "/api/sheets/workbooks/:id/versions/:versionId",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        const version = await storage.getSheetWorkbookVersion(req.params.versionId);
        if (!version || version.workbookId !== req.params.id) {
          return res.status(404).json({ error: "Version not found" });
        }
        res.json({ version });
      } catch (err: any) {
        console.error("[sheets] getVersion failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get version" });
      }
    },
  );

  // Manually save a version checkpoint — write permission required.
  app.post(
    "/api/sheets/workbooks/:id/versions",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canWrite = await storage.canUserWriteWorkbook(req.params.id, userId);
        if (!canWrite) return res.status(403).json({ error: "Forbidden — editor access required" });

        const body = z.object({
          snapshot: z.unknown(),
          label: z.string().max(255).optional().nullable(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        if (snapshotBytes(body.data.snapshot) > SNAPSHOT_MAX_BYTES) {
          return res.status(413).json({ error: "Snapshot exceeds 10 MB limit" });
        }

        const version = await storage.saveManualVersion({
          workbookId: req.params.id,
          snapshot: body.data.snapshot,
          createdBy: userId,
          label: body.data.label,
        });
        logActivity({
          workbookId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "version_saved",
          detail: body.data.label ? { label: body.data.label } : null,
        });
        res.status(201).json({ version });
      } catch (err: any) {
        console.error("[sheets] saveManualVersion failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to save version" });
      }
    },
  );

  // Restore a workbook to a specific version — write permission required.
  // The current snapshot is versioned first so the restore is itself undoable.
  app.post(
    "/api/sheets/workbooks/:id/versions/:versionId/restore",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canWrite = await storage.canUserWriteWorkbook(req.params.id, userId);
        if (!canWrite) return res.status(403).json({ error: "Forbidden — editor access required" });

        const updated = await storage.restoreSheetWorkbookVersion({
          versionId: req.params.versionId,
          workbookId: req.params.id,
          restoredBy: userId,
        });
        logActivity({
          workbookId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "restored",
          detail: { versionId: req.params.versionId },
        });
        res.json({ workbook: updated });
      } catch (err: any) {
        console.error("[sheets] restoreVersion failed:", err?.message ?? err);
        const msg = err?.message ?? "Failed to restore version";
        const status = msg.includes("not found") ? 404 : 500;
        res.status(status).json({ error: msg });
      }
    },
  );

  // ---- Activity log ----

  /**
   * GET /api/sheets/workbooks/:id/activity
   * Query: { limit?: number }  (default 50, max 200)
   * Permission: any user who can access (view) the workbook.
   */
  app.get(
    "/api/sheets/workbooks/:id/activity",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId, userRole);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        const rawLimit = parseInt(String(req.query.limit ?? "50"), 10);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
        const activity = await storage.listSheetWorkbookActivity(req.params.id, limit);
        res.json({ activity });
      } catch (err: any) {
        console.error("[sheets] listActivity failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list activity" });
      }
    },
  );

  // List data blocks for a workbook.
  app.get(
    "/api/sheets/workbooks/:id/blocks",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const canRead = await storage.canUserAccessWorkbook(req.params.id, userId, userRole);
        if (!canRead) return res.status(403).json({ error: "Forbidden" });
        const blocks = await storage.listSheetDataBlocks(req.params.id);
        res.json({ blocks });
      } catch (err: any) {
        console.error("[sheets] listBlocks failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list data blocks" });
      }
    },
  );

  // ---- Workbook role-level grants ----

  const upsertRoleGrantSchema = z.object({
    role: z.string().min(1),
    accessLevel: z.enum(workbookRoleGrantAccessLevels),
  });

  // List role grants for a workbook (owner or CEO only).
  app.get(
    "/api/sheets/workbooks/:id/role-grants",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const roleGrants = await storage.listSheetWorkbookRoleGrants(req.params.id);
        res.json({ roleGrants });
      } catch (err: any) {
        console.error("[sheets] listRoleGrants failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list role grants" });
      }
    },
  );

  // Create a data block.
  app.post(
    "/api/sheets/workbooks/:id/blocks",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const canWrite = await storage.canUserWriteWorkbook(req.params.id, userId, userRole);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });
        const body = insertBlockSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const block = await storage.createSheetDataBlock({
          workbookId: req.params.id,
          sheetId: body.data.sheetId,
          label: body.data.label,
          connectorId: body.data.connectorId,
          connectorParams: body.data.connectorParams,
          startRow: body.data.startRow,
          startCol: body.data.startCol,
          autoRefresh: body.data.autoRefresh,
          createdBy: userId,
        });
        // Enqueue an immediate refresh so the block populates right away.
        await enqueueSheetDataBlockRefresh(block.id, userId, req.user.claims.role ?? "account_manager");
        res.status(201).json({ block });
      } catch (err: any) {
        console.error("[sheets] createBlock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to create data block" });
      }
    },
  );

  // Upsert a role grant (owner or CEO only).
  app.put(
    "/api/sheets/workbooks/:id/role-grants",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const body = upsertRoleGrantSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const { role, accessLevel } = body.data;
        const roleGrant = await storage.upsertSheetWorkbookRoleGrant({
          workbookId: req.params.id,
          role,
          accessLevel,
          grantedBy: callerId,
        });
        res.json({ roleGrant });
      } catch (err: any) {
        console.error("[sheets] upsertRoleGrant failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update role grant" });
      }
    },
  );

  // Update a data block (label / autoRefresh only).
  app.patch(
    "/api/sheets/workbooks/:wId/blocks/:bId",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const canWrite = await storage.canUserWriteWorkbook(req.params.wId, userId);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });
        const block = await storage.getSheetDataBlock(req.params.bId);
        if (!block || block.workbookId !== req.params.wId)
          return res.status(404).json({ error: "Block not found" });
        const body = z.object({
          label: z.string().min(1).max(255).optional(),
          autoRefresh: z.boolean().optional(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const updated = await storage.updateSheetDataBlock(req.params.bId, body.data);
        res.json({ block: updated });
      } catch (err: any) {
        console.error("[sheets] updateBlock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update data block" });
      }
    },
  );

  // Delete a data block.
  app.delete(
    "/api/sheets/workbooks/:wId/blocks/:bId",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const canWrite = await storage.canUserWriteWorkbook(req.params.wId, userId);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });
        const block = await storage.getSheetDataBlock(req.params.bId);
        if (!block || block.workbookId !== req.params.wId)
          return res.status(404).json({ error: "Block not found" });
        await storage.deleteSheetDataBlock(req.params.bId);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deleteBlock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete data block" });
      }
    },
  );

  // Delete a role grant (owner or CEO only).
  app.delete(
    "/api/sheets/workbooks/:id/role-grants/:role",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        await storage.deleteSheetWorkbookRoleGrant(req.params.id, req.params.role);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deleteRoleGrant failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete role grant" });
      }
    },
  );

  // ---- Duplicate workbook ----

  /**
   * POST /api/sheets/workbooks/:id/duplicate
   * Body (optional): { name?: string, folderId?: string | null }
   * Access: any user who can view the workbook; copy is owned by the caller.
   */
  app.post(
    "/api/sheets/workbooks/:id/duplicate",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        const canAccess = await storage.canUserAccessWorkbook(req.params.id, userId);
        if (!canAccess) return res.status(403).json({ error: "Forbidden" });

        const body = z.object({
          name: z.string().min(1).max(255).optional(),
          folderId: z.string().nullable().optional(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const newName = body.data.name ?? `${workbook.name} (copy)`;
        const { workbook: newWorkbook, blockCount } = await storage.duplicateWorkbook(
          req.params.id,
          userId,
          newName,
          body.data.folderId,
        );
        logActivity({
          workbookId: newWorkbook.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "duplicated",
          detail: { sourceWorkbookId: req.params.id, name: newName },
        });
        res.status(201).json({ workbook: { ...newWorkbook, snapshot: undefined }, blockCount });
      } catch (err: any) {
        console.error("[sheets] duplicateWorkbook failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to duplicate workbook" });
      }
    },
  );

  // ---- Save workbook as template ----

  /**
   * POST /api/sheets/workbooks/:id/save-as-template
   * Body: { name: string, description?: string }
   * Access: workbook owner or CEO.
   */
  app.post(
    "/api/sheets/workbooks/:id/save-as-template",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const role: string = req.user.claims.role ?? "";
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        const isCeo = role === "ceo";
        if (workbook.ownerId !== userId && !isCeo) {
          return res.status(403).json({ error: "Forbidden — owner or CEO only" });
        }

        const body = z.object({
          name: z.string().min(1).max(255),
          description: z.string().max(1000).default(""),
          existingTemplateId: z.string().optional(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const template = await storage.saveWorkbookAsTemplate(
          req.params.id,
          userId,
          body.data.name,
          body.data.description,
          body.data.existingTemplateId,
        );
        res.status(201).json({ template });
      } catch (err: any) {
        console.error("[sheets] saveAsTemplate failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to save as template" });
      }
    },
  );

  // ---- Templates gallery & management ----

  /**
   * GET /api/sheets/templates
   * Query: { includeArchived?: "true" }
   * Access: any authenticated account_manager+
   */
  app.get(
    "/api/sheets/templates",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const includeArchived = req.query.includeArchived === "true";
        const templates = await storage.listSheetTemplates({ includeArchived });
        res.json({ templates });
      } catch (err: any) {
        console.error("[sheets] listTemplates failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list templates" });
      }
    },
  );

  /**
   * GET /api/sheets/templates/:id
   */
  app.get(
    "/api/sheets/templates/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const template = await storage.getSheetTemplate(req.params.id);
        if (!template) return res.status(404).json({ error: "Template not found" });
        res.json({ template });
      } catch (err: any) {
        console.error("[sheets] getTemplate failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get template" });
      }
    },
  );

  /**
   * PATCH /api/sheets/templates/:id
   * Body: { name?, description?, archive?: boolean }
   * Access: creator or CEO.
   */
  app.patch(
    "/api/sheets/templates/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const role: string = req.user.claims.role ?? "";
        const template = await storage.getSheetTemplate(req.params.id);
        if (!template) return res.status(404).json({ error: "Template not found" });

        const isCeo = role === "ceo";
        if (template.createdBy !== userId && !isCeo) {
          return res.status(403).json({ error: "Forbidden — creator or CEO only" });
        }

        const body = z.object({
          name: z.string().min(1).max(255).optional(),
          description: z.string().max(1000).optional(),
          archive: z.boolean().optional(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const patch: any = {};
        if (body.data.name !== undefined) patch.name = body.data.name;
        if (body.data.description !== undefined) patch.description = body.data.description;
        if (body.data.archive === true) patch.archivedAt = new Date();
        if (body.data.archive === false) patch.archivedAt = null;

        const updated = await storage.updateSheetTemplate(req.params.id, patch);
        res.json({ template: updated });
      } catch (err: any) {
        console.error("[sheets] updateTemplate failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update template" });
      }
    },
  );

  /**
   * DELETE /api/sheets/templates/:id
   * Access: creator or CEO.
   */
  app.delete(
    "/api/sheets/templates/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const role: string = req.user.claims.role ?? "";
        const template = await storage.getSheetTemplate(req.params.id);
        if (!template) return res.status(404).json({ error: "Template not found" });

        const isCeo = role === "ceo";
        if (template.createdBy !== userId && !isCeo) {
          return res.status(403).json({ error: "Forbidden — creator or CEO only" });
        }

        await storage.deleteSheetTemplate(req.params.id);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] deleteTemplate failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete template" });
      }
    },
  );

  /**
   * POST /api/sheets/templates/:id/workbook
   * Body: { name: string, folderId?: string | null }
   * Access: any account_manager+
   */
  app.post(
    "/api/sheets/templates/:id/workbook",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const template = await storage.getSheetTemplate(req.params.id);
        if (!template) return res.status(404).json({ error: "Template not found" });
        if (template.archivedAt) return res.status(410).json({ error: "Template is archived" });

        const body = z.object({
          name: z.string().min(1).max(255),
          folderId: z.string().nullable().optional(),
        }).safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const { workbook, blockCount } = await storage.createWorkbookFromTemplate(
          req.params.id,
          userId,
          body.data.name,
          body.data.folderId,
        );
        res.status(201).json({ workbook: { ...workbook, snapshot: undefined }, blockCount });
      } catch (err: any) {
        console.error("[sheets] createFromTemplate failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to create workbook from template" });
      }
    },
  );

  /**
   * GET /api/sheets/workbooks/:id/tabs
   * Returns tab names from the workbook snapshot — lightweight alternative to
   * loading the full editor. Used by the Publish as Dashboard dialog.
   * Owner or CEO only.
   */
  app.get(
    "/api/sheets/workbooks/:id/tabs",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden — owner or CEO only" });
        }
        let tabs: { sheetId: string; sheetName: string }[] = [];
        if (workbook.snapshot) {
          try {
            const snap = (typeof workbook.snapshot === "string"
              ? JSON.parse(workbook.snapshot)
              : workbook.snapshot) as {
              sheets?: Record<string, { name?: string; hidden?: number }>;
              sheetOrder?: string[];
            };
            const sheetOrder = snap.sheetOrder ?? Object.keys(snap.sheets ?? {});
            tabs = sheetOrder
              .filter((sid) => snap.sheets?.[sid] && !snap.sheets[sid].hidden)
              .map((sid) => ({ sheetId: sid, sheetName: snap.sheets![sid].name ?? sid }));
          } catch {
            tabs = [];
          }
        }
        res.json({ tabs });
      } catch (err: any) {
        console.error("[sheets] getTabs failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get workbook tabs" });
      }
    },
  );

  // ---- Published Dashboards ----

  const publishDashboardSchema = z.object({
    title: z.string().min(1).max(255),
    tabs: z.array(z.object({ sheetId: z.string(), sheetName: z.string() })).default([]),
    audienceUserIds: z.array(z.string()).default([]),
    audienceRoles: z.array(z.string()).default([]),
  });

  /**
   * POST /api/sheets/workbooks/:id/dashboard
   * Publish (or update) a workbook as a dashboard. Owner or CEO only.
   */
  app.post(
    "/api/sheets/workbooks/:id/dashboard",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden — owner or CEO only" });
        }

        const body = publishDashboardSchema.safeParse(req.body);
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const dashboard = await storage.publishWorkbookAsDashboard(
          req.params.id,
          callerId,
          body.data,
        );
        res.status(201).json({ dashboard });
      } catch (err: any) {
        console.error("[sheets] publishDashboard failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to publish dashboard" });
      }
    },
  );

  /**
   * DELETE /api/sheets/workbooks/:id/dashboard
   * Unpublish a dashboard. Owner or CEO only.
   */
  app.delete(
    "/api/sheets/workbooks/:id/dashboard",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden — owner or CEO only" });
        }
        await storage.unpublishWorkbookDashboard(req.params.id);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[sheets] unpublishDashboard failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to unpublish dashboard" });
      }
    },
  );

  /**
   * GET /api/sheets/workbooks/:id/dashboard
   * Get the published dashboard config for a workbook (if any). Owner or CEO only.
   */
  app.get(
    "/api/sheets/workbooks/:id/dashboard",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });
        if (!(await isOwnerOrCeo(req.params.id, callerId, userRole))) {
          return res.status(403).json({ error: "Forbidden — owner or CEO only" });
        }
        const dashboard = await storage.getWorkbookDashboard(req.params.id);
        res.json({ dashboard: dashboard ?? null });
      } catch (err: any) {
        console.error("[sheets] getDashboardConfig failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get dashboard config" });
      }
    },
  );

  /**
   * GET /api/sheets/dashboards
   * List all published dashboards visible to the caller.
   */
  app.get(
    "/api/sheets/dashboards",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const dashboards = await storage.listPublishedDashboards(userId, userRole);
        res.json({ dashboards });
      } catch (err: any) {
        console.error("[sheets] listDashboards failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list dashboards" });
      }
    },
  );

  /**
   * GET /api/sheets/dashboards/:id
   * Get a single dashboard + the workbook snapshot for rendering.
   * Access: anyone who passes canUserViewDashboard.
   */
  app.get(
    "/api/sheets/dashboards/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const canView = await storage.canUserViewDashboard(req.params.id, userId, userRole);
        if (!canView) return res.status(403).json({ error: "Forbidden" });

        const dashboard = await storage.getWorkbookDashboard(req.params.id);
        if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });

        const workbook = await storage.getSheetWorkbook(req.params.id);
        if (!workbook) return res.status(404).json({ error: "Workbook not found" });

        res.json({
          dashboard,
          snapshot: workbook.snapshot,
          workbookName: workbook.name,
          updatedAt: workbook.updatedAt,
        });
      } catch (err: any) {
        console.error("[sheets] getDashboard failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get dashboard" });
      }
    },
  );

  // Manual refresh a data block.
  app.post(
    "/api/sheets/workbooks/:wId/blocks/:bId/refresh",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        if (writesDisabled()) {
          return res.status(503).json({ error: "SHEETS_WRITES_DISABLED", message: "Sheets writes are temporarily disabled for maintenance." });
        }
        const userId: string = req.user.claims.sub;
        const canWrite = await storage.canUserWriteWorkbook(req.params.wId, userId);
        if (!canWrite) return res.status(403).json({ error: "Forbidden" });
        const block = await storage.getSheetDataBlock(req.params.bId);
        if (!block || block.workbookId !== req.params.wId)
          return res.status(404).json({ error: "Block not found" });
        await enqueueSheetDataBlockRefresh(block.id, userId, req.user.claims.role ?? "account_manager");
        res.json({ ok: true, message: "Refresh enqueued" });
      } catch (err: any) {
        console.error("[sheets] refreshBlock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to enqueue refresh" });
      }
    },
  );
}

// ---- helpers ----

function serializeLock(lock: import("@shared/schema").SheetWorkbookLock) {
  return {
    workbookId: lock.workbookId,
    holderUserId: lock.holderUserId,
    holderName: lock.holderName,
    acquiredAt: lock.acquiredAt.toISOString(),
    heartbeatAt: lock.heartbeatAt.toISOString(),
    expiresAt: lock.expiresAt.toISOString(),
  };
}
