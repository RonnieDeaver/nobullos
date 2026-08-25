/**
 * NoBull Docs routes (Task #4024) — Google Docs-style documents.
 *
 * Mirrors the NoBull Sheets route contracts (server/routes/sheets.ts):
 *   - Snapshot saves guarded by optimistic revision (409 REVISION_CONFLICT)
 *     and the single-editor lock (423 LOCK_REQUIRED when someone else holds it).
 *   - Lock lifecycle: acquire / heartbeat / release / peek.
 *   - Version history: auto-captured on save (5-min spacing), manual
 *     checkpoints, restore with a restore-point safety version.
 *   - Activity trail per document.
 *   - DOCX import (multipart upload) and export (attachment download).
 *
 * Access model (Task #4053 added per-user viewer/editor grants, mirroring
 * Sheets' workbook permissions minus role-level grants):
 *   - All routes require account_manager+ (same as Sheets).
 *   - CEO sees/edits everything (owner-equivalent).
 *   - Owners have full access; client-linked documents are team-shared
 *     (editor-equivalent for every account manager).
 *   - Explicit per-user grants give viewer (read-only) or editor access.
 *   - Write paths (snapshot save, rename/re-link, lock acquire, manual
 *     version, restore) require editor+; viewers get 403.
 *   - Delete and permission management are owner-or-CEO only (same as Sheets).
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { isAuthenticated } from "../middlewares/requireAuth";
import {
  requireAccountManager,
  writeLimiter,
  uploadLimiter,
  sheetsAutosaveLimiter,
  docsImportUpload,
} from "./middleware";
import {
  convertDocxToDocumentSnapshot,
  DOCS_IMPORT_MAX_FILE_BYTES,
} from "../services/docsImportConverter";
import { convertDocumentSnapshotToDocx } from "../services/docsExportConverter";
import { docPermissionRoleOptions } from "@shared/schema";
import type { DocDocument, DocDocumentMeta } from "@shared/schema";

/** Hard cap on stored snapshot size (same as Sheets). */
const SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
/** Emit a size warning header when a saved snapshot crosses this. */
const SNAPSHOT_WARN_BYTES = Math.floor(SNAPSHOT_MAX_BYTES * 0.8);

export function registerDocsRoutes(app: Express): void {
  // ---- helpers ----

  const callerRole = (req: any): string | undefined => req.dbUser?.role;

  const callerDisplayName = (req: any): string => {
    const u = req.dbUser;
    if (u?.firstName || u?.lastName) {
      return [u.firstName, u.lastName].filter(Boolean).join(" ");
    }
    return u?.email ?? req.user?.claims?.sub ?? "Unknown";
  };

  /** Fire-and-forget activity logging — never blocks or fails a response. */
  const logActivity = (params: Parameters<typeof storage.logDocActivity>[0]): void => {
    storage.logDocActivity(params).catch((err: any) =>
      console.warn("[docs] logActivity failed:", err?.message ?? err),
    );
  };

  const snapshotBytes = (snapshot: unknown): number =>
    Buffer.byteLength(JSON.stringify(snapshot ?? null), "utf8");

  /**
   * Effective access level: "owner" | "editor" | "viewer" | null.
   * Owner/CEO → owner; client-linked → editor (team-shared); explicit
   * per-user grant → its role; otherwise null (403).
   */
  const accessLevel = (
    doc: DocDocument | DocDocumentMeta,
    userId: string,
    role: string | undefined,
  ) => storage.getDocAccessLevel(doc, userId, role);

  const canWrite = (level: string | null): boolean =>
    level === "owner" || level === "editor";

  const isOwnerOrCeo = (
    doc: DocDocument | DocDocumentMeta,
    userId: string,
    role: string | undefined,
  ): boolean => role === "ceo" || doc.ownerId === userId;

  /** Validate an optional clientId refers to a real client. */
  const resolveClientId = async (
    raw: unknown,
  ): Promise<{ ok: true; clientId: string | null } | { ok: false }> => {
    if (raw === undefined || raw === null || raw === "") return { ok: true, clientId: null };
    if (typeof raw !== "string") return { ok: false };
    const client = await storage.getClient(raw);
    if (!client) return { ok: false };
    return { ok: true, clientId: raw };
  };

  const serializeLock = (lock: import("@shared/schema").DocDocumentLock) => ({
    documentId: lock.documentId,
    holderUserId: lock.holderUserId,
    holderName: lock.holderName,
    acquiredAt: lock.acquiredAt.toISOString(),
    heartbeatAt: lock.heartbeatAt.toISOString(),
    expiresAt: lock.expiresAt.toISOString(),
  });

  // ---- documents CRUD ----

  /**
   * GET /api/docs/documents
   * Query: { clientId?: string } — restrict to one client's documents.
   * Returns metadata only (no snapshot bodies).
   */
  // Task #4488 — server-side pagination/search/sort for the documents table.
  // All params optional; omitting `limit` keeps the legacy full-list shape.
  const listDocumentsQuerySchema = z.object({
    clientId: z.string().max(255).optional(),
    q: z.string().trim().max(300).optional(),
    sort: z.enum(["name", "updated", "owner"]).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  });

  app.get(
    "/api/docs/documents",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const query = listDocumentsQuerySchema.safeParse(req.query);
        if (!query.success) {
          return res.status(400).json({ error: "Invalid list parameters" });
        }
        const { clientId, q, sort, dir, limit, offset } = query.data;

        // Client-linked documents are visible to every account manager
        // (clientId set); otherwise the caller's own/shared visibility set.
        const { documents, total } = await storage.listDocDocumentsPage({
          userId,
          userRole,
          clientId: clientId || undefined,
          q,
          sort,
          dir,
          limit,
          offset,
        });
        res.json({ documents, total });
      } catch (err: any) {
        console.error("[docs] listDocuments failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list documents" });
      }
    },
  );

  const createDocumentSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    clientId: z.string().max(255).nullable().optional(),
    snapshot: z.unknown().optional(),
  });

  /**
   * POST /api/docs/documents
   * Body: { name?, clientId?, snapshot? }
   * Returns: 201 { document }
   */
  app.post(
    "/api/docs/documents",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const body = createDocumentSchema.safeParse(req.body ?? {});
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }

        const clientRef = await resolveClientId(body.data.clientId);
        if (!clientRef.ok) {
          return res.status(400).json({ error: "Client not found" });
        }

        if (body.data.snapshot !== undefined && snapshotBytes(body.data.snapshot) > SNAPSHOT_MAX_BYTES) {
          return res.status(413).json({ error: "Snapshot exceeds 10 MB limit" });
        }

        const document = await storage.createDocDocument({
          name: (body.data.name ?? "Untitled document").trim().slice(0, 255) || "Untitled document",
          ownerId: userId,
          clientId: clientRef.clientId,
          snapshot: (body.data.snapshot as any) ?? null,
        });

        logActivity({
          documentId: document.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "created",
          detail: clientRef.clientId ? { clientId: clientRef.clientId } : null,
        });
        res.status(201).json({ document });
      } catch (err: any) {
        console.error("[docs] createDocument failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to create document" });
      }
    },
  );

  /**
   * GET /api/docs/documents/:id — full document including snapshot.
   */
  app.get(
    "/api/docs/documents/:id",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        const level = await accessLevel(document, userId, userRole);
        if (!level) {
          return res.status(403).json({ error: "Forbidden" });
        }
        res.json({ document, userPermission: level });
      } catch (err: any) {
        console.error("[docs] getDocument failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get document" });
      }
    },
  );

  const updateDocumentSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    clientId: z.string().max(255).nullable().optional(),
    snapshot: z.unknown().optional(),
    expectedRevision: z.number().int().min(0).optional(),
  });

  /**
   * PATCH /api/docs/documents/:id
   *
   * Two paths, mirroring Sheets:
   *   - snapshot save: requires `expectedRevision` (409 on mismatch), rejects
   *     when another user holds the edit lock (423), 413 over 10 MB, captures
   *     an auto-version (5-min spacing) before overwriting.
   *   - metadata-only: rename / re-link client; logs "renamed" when the name
   *     actually changed.
   */
  app.patch(
    "/api/docs/documents/:id",
    isAuthenticated,
    requireAccountManager,
    sheetsAutosaveLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Every PATCH path mutates the document (snapshot save OR
        // rename/re-link), so viewers are rejected outright.
        const level = await accessLevel(document, userId, userRole);
        if (!canWrite(level)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const body = updateDocumentSchema.safeParse(req.body ?? {});
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const patch = body.data;

        let clientPatch: { clientId: string | null } | undefined;
        if (patch.clientId !== undefined) {
          const clientRef = await resolveClientId(patch.clientId);
          if (!clientRef.ok) return res.status(400).json({ error: "Client not found" });
          clientPatch = { clientId: clientRef.clientId };
        }

        // ---- snapshot save path: enforce lock + revision ----
        if (patch.snapshot !== undefined) {
          if (snapshotBytes(patch.snapshot) > SNAPSHOT_MAX_BYTES) {
            return res.status(413).json({ error: "Snapshot exceeds 10 MB limit" });
          }

          // Belt-and-braces: reject when someone ELSE holds the edit lock.
          const lock = await storage.getDocumentLock(req.params.id);
          if (lock && lock.holderUserId !== userId) {
            return res.status(423).json({
              error: "LOCK_REQUIRED",
              message: `${lock.holderName} is currently editing this document`,
              lock: serializeLock(lock),
            });
          }

          if (patch.expectedRevision === undefined) {
            return res.status(400).json({
              error: "MISSING_REVISION",
              message: "expectedRevision is required when saving a snapshot",
            });
          }

          // Capture auto-version before overwriting (fire-and-forget).
          storage.captureDocAutoVersion({
            documentId: req.params.id,
            snapshot: patch.snapshot,
            createdBy: userId,
          }).catch((err: any) =>
            console.warn("[docs] captureDocAutoVersion failed:", err?.message ?? err),
          );

          const result = await storage.saveDocDocumentSnapshot(
            req.params.id,
            patch.snapshot,
            patch.expectedRevision,
          );

          if (!result.ok) {
            return res.status(409).json({
              error: "REVISION_CONFLICT",
              message: "This document was modified by another session. Reload to continue.",
              currentRevision: result.currentRevision,
            });
          }

          const savedBytes = snapshotBytes(patch.snapshot);
          if (savedBytes >= SNAPSHOT_WARN_BYTES) {
            res.setHeader(
              "X-Snapshot-Size-Warning",
              `${savedBytes} bytes — approaching the 10 MB limit. Consider splitting this document.`,
            );
          }

          // Apply any non-snapshot fields (name, clientId) if also provided.
          let finalDocument = result.document;
          const metaPatch: Record<string, unknown> = {};
          if (patch.name !== undefined) metaPatch.name = patch.name;
          if (clientPatch) metaPatch.clientId = clientPatch.clientId;
          if (Object.keys(metaPatch).length > 0) {
            finalDocument =
              (await storage.updateDocDocument(req.params.id, metaPatch as any)) ??
              finalDocument;
          }

          return res.json({ document: finalDocument });
        }

        // ---- metadata-only update (name / clientId) ----
        const updated = await storage.updateDocDocument(req.params.id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(clientPatch ?? {}),
        });
        if (patch.name !== undefined && patch.name !== document.name) {
          logActivity({
            documentId: req.params.id,
            actorId: userId,
            actorName: callerDisplayName(req),
            action: "renamed",
            detail: { oldName: document.name, newName: patch.name },
          });
        }
        res.json({ document: updated });
      } catch (err: any) {
        console.error("[docs] updateDocument failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update document" });
      }
    },
  );

  /**
   * DELETE /api/docs/documents/:id — owner or CEO only.
   * Locks, versions, and activity cascade via FK.
   */
  app.delete(
    "/api/docs/documents/:id",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!isOwnerOrCeo(document, userId, userRole)) {
          return res.status(403).json({ error: "Forbidden — owner only" });
        }
        await storage.deleteDocDocument(req.params.id);
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[docs] deleteDocument failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to delete document" });
      }
    },
  );

  // ---- edit lock lifecycle ----

  /**
   * POST /api/docs/documents/:id/lock
   * Body: { holderName?: string }
   * Returns { acquired: boolean, lock } — 200 either way; the caller checks
   * `acquired` and shows the read-only banner when false.
   */
  app.post(
    "/api/docs/documents/:id/lock",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Only editors+ may hold the edit lock; viewers open read-only.
        const level = await accessLevel(document, userId, userRole);
        if (!canWrite(level)) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const holderName =
          (typeof req.body?.holderName === "string" && req.body.holderName.trim()) ||
          callerDisplayName(req);

        const result = await storage.acquireDocumentLock(req.params.id, userId, holderName);
        res.json({ acquired: result.acquired, lock: serializeLock(result.lock) });
      } catch (err: any) {
        console.error("[docs] acquireLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to acquire lock" });
      }
    },
  );

  /**
   * POST /api/docs/documents/:id/lock/heartbeat
   * Returns { lock } or 409 LOCK_LOST when the caller no longer holds it.
   */
  app.post(
    "/api/docs/documents/:id/lock/heartbeat",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Editor+ only — a revoked grantee must not keep extending a lock
        // and blocking legitimate editors (Task #4053 review finding).
        if (!canWrite(await accessLevel(document, userId, callerRole(req)))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const lock = await storage.heartbeatDocumentLock(req.params.id, userId);
        if (!lock) {
          return res.status(409).json({
            error: "LOCK_LOST",
            message: "Your edit lock has expired or was taken by another user.",
          });
        }
        res.json({ lock: serializeLock(lock) });
      } catch (err: any) {
        console.error("[docs] heartbeatLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to heartbeat lock" });
      }
    },
  );

  /**
   * DELETE /api/docs/documents/:id/lock — release own lock (idempotent).
   * Logs an "edited" activity with the session duration when the caller
   * actually held the lock.
   */
  app.delete(
    "/api/docs/documents/:id/lock",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Editor+ only, matching acquire/heartbeat. Revoked holders don't
        // need this route: revocation deletes their lock server-side.
        if (!canWrite(await accessLevel(document, userId, callerRole(req)))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const lock = await storage.getDocumentLock(req.params.id);
        await storage.releaseDocumentLock(req.params.id, userId);
        if (lock && lock.holderUserId === userId) {
          logActivity({
            documentId: req.params.id,
            actorId: userId,
            actorName: callerDisplayName(req),
            action: "edited",
            detail: { duration_ms: Date.now() - lock.acquiredAt.getTime() },
          });
        }
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[docs] releaseLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to release lock" });
      }
    },
  );

  /**
   * GET /api/docs/documents/:id/lock — peek at the current lock.
   * Returns { locked: false } or { locked: true, lock }.
   */
  app.get(
    "/api/docs/documents/:id/lock",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Viewer+ — lock state (holder identity/timestamps) is document
        // metadata and must not leak on private documents.
        if (!(await accessLevel(document, userId, callerRole(req)))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const lock = await storage.getDocumentLock(req.params.id);
        if (!lock) return res.json({ locked: false });
        res.json({ locked: true, lock: serializeLock(lock) });
      } catch (err: any) {
        console.error("[docs] getLock failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get lock" });
      }
    },
  );

  // ---- per-user sharing grants (Task #4053) ----
  // Mirrors the Sheets permissions routes: owner or CEO manages grants;
  // grantees get viewer (read-only) or editor access. No role-level grants
  // and no "owner" grant level for docs.

  const upsertPermSchema = z.object({
    userId: z.string().min(1).max(255),
    role: z.enum(docPermissionRoleOptions),
  });

  /**
   * GET /api/docs/team-roster — minimal teammate list for the Share dialog
   * grantee picker. `/api/users` is team-lead-gated and returns full user
   * rows; document owners are usually account managers, so sharing needs an
   * AM-accessible roster. Only identity fields are exposed.
   */
  app.get(
    "/api/docs/team-roster",
    isAuthenticated,
    requireAccountManager,
    async (_req: any, res) => {
      try {
        const all = await storage.getAllUsers();
        const users = all.map((u) => ({
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          role: u.role,
        }));
        res.json({ users });
      } catch (err: any) {
        console.error("[docs] teamRoster failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list teammates" });
      }
    },
  );

  /**
   * GET /api/docs/documents/:id/permissions — list grants (owner or CEO only).
   */
  app.get(
    "/api/docs/documents/:id/permissions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!isOwnerOrCeo(document, userId, userRole)) {
          return res.status(403).json({ error: "Forbidden — owner only" });
        }
        const permissions = await storage.listDocDocumentPermissions(req.params.id);
        res.json({ permissions });
      } catch (err: any) {
        console.error("[docs] listPermissions failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list permissions" });
      }
    },
  );

  /**
   * PUT /api/docs/documents/:id/permissions — grant or update a user's access.
   * Body: { userId, role: "viewer" | "editor" } (owner or CEO only).
   */
  app.put(
    "/api/docs/documents/:id/permissions",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!isOwnerOrCeo(document, callerId, userRole)) {
          return res.status(403).json({ error: "Forbidden — owner only" });
        }

        const body = upsertPermSchema.safeParse(req.body ?? {});
        if (!body.success) {
          return res.status(400).json({ error: "Invalid request", details: body.error.flatten() });
        }
        const { userId, role } = body.data;

        if (userId === document.ownerId) {
          return res.status(400).json({ error: "The owner already has full access" });
        }
        // Validate the grantee exists up front (clearer than an FK 500).
        const grantee = await storage.getUser(userId);
        if (!grantee) return res.status(400).json({ error: "User not found" });

        const permission = await storage.upsertDocDocumentPermission({
          documentId: req.params.id,
          userId,
          role,
          grantedBy: callerId,
        });
        logActivity({
          documentId: req.params.id,
          actorId: callerId,
          actorName: callerDisplayName(req),
          action: "shared",
          detail: { targetUserId: userId, role },
        });
        res.json({ permission });
      } catch (err: any) {
        console.error("[docs] upsertPermission failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to update permission" });
      }
    },
  );

  /**
   * DELETE /api/docs/documents/:id/permissions/:userId — revoke a grant
   * (owner or CEO only). Idempotent.
   */
  app.delete(
    "/api/docs/documents/:id/permissions/:userId",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const callerId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!isOwnerOrCeo(document, callerId, userRole)) {
          return res.status(403).json({ error: "Forbidden — owner only" });
        }
        await storage.deleteDocDocumentPermission(req.params.id, req.params.userId);
        // If the revoked user currently holds the edit lock and has no
        // remaining write access (e.g. via client-linking), release it so
        // they can't keep blocking legitimate editors.
        const heldLock = await storage.getDocumentLock(req.params.id);
        if (heldLock && heldLock.holderUserId === req.params.userId) {
          const remaining = await storage.getDocAccessLevel(document, req.params.userId);
          if (!canWrite(remaining)) {
            await storage.releaseDocumentLock(req.params.id, req.params.userId);
          }
        }
        logActivity({
          documentId: req.params.id,
          actorId: callerId,
          actorName: callerDisplayName(req),
          action: "unshared",
          detail: { targetUserId: req.params.userId },
        });
        res.json({ ok: true });
      } catch (err: any) {
        console.error("[docs] deletePermission failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to revoke permission" });
      }
    },
  );

  // ---- version history & restore ----

  /**
   * GET /api/docs/documents/:id/versions — metadata only, newest first.
   */
  app.get(
    "/api/docs/documents/:id/versions",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const versions = await storage.listDocDocumentVersions(req.params.id);
        res.json({ versions });
      } catch (err: any) {
        console.error("[docs] listVersions failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list versions" });
      }
    },
  );

  /**
   * GET /api/docs/documents/:id/versions/:versionId — includes snapshot
   * (used for the version preview pane).
   */
  app.get(
    "/api/docs/documents/:id/versions/:versionId",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const version = await storage.getDocDocumentVersion(req.params.versionId);
        if (!version || version.documentId !== req.params.id) {
          return res.status(404).json({ error: "Version not found" });
        }
        res.json({ version });
      } catch (err: any) {
        console.error("[docs] getVersion failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to get version" });
      }
    },
  );

  /**
   * POST /api/docs/documents/:id/versions — manual checkpoint.
   * Body: { snapshot, label? }
   */
  app.post(
    "/api/docs/documents/:id/versions",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Manual version checkpoints are writes — editor+ only.
        if (!canWrite(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }

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

        const version = await storage.saveDocManualVersion({
          documentId: req.params.id,
          snapshot: body.data.snapshot,
          createdBy: userId,
          label: body.data.label,
        });
        logActivity({
          documentId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "version_saved",
          detail: body.data.label ? { label: body.data.label } : null,
        });
        res.status(201).json({ version });
      } catch (err: any) {
        console.error("[docs] saveManualVersion failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to save version" });
      }
    },
  );

  /**
   * POST /api/docs/documents/:id/versions/:versionId/restore
   * The current snapshot is saved as a restore point first, so the restore
   * is itself undoable.
   */
  app.post(
    "/api/docs/documents/:id/versions/:versionId/restore",
    isAuthenticated,
    requireAccountManager,
    writeLimiter,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        // Restore rewrites the current snapshot — editor+ only.
        if (!canWrite(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const updated = await storage.restoreDocDocumentVersion({
          versionId: req.params.versionId,
          documentId: req.params.id,
          restoredBy: userId,
        });
        logActivity({
          documentId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "restored",
          detail: { versionId: req.params.versionId },
        });
        res.json({ document: updated });
      } catch (err: any) {
        console.error("[docs] restoreVersion failed:", err?.message ?? err);
        const msg = err?.message ?? "Failed to restore version";
        const status = String(msg).includes("not found") ? 404 : 500;
        res.status(status).json({ error: msg });
      }
    },
  );

  // ---- activity trail ----

  /**
   * GET /api/docs/documents/:id/activity
   * Query: { limit?: number } (default 50, max 200)
   */
  app.get(
    "/api/docs/documents/:id/activity",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const limit = Number(req.query.limit) || 50;
        const activity = await storage.listDocDocumentActivity(req.params.id, limit);
        res.json({ activity });
      } catch (err: any) {
        console.error("[docs] listActivity failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list activity" });
      }
    },
  );

  // ---- DOCX import / export ----

  /**
   * POST /api/docs/documents/import
   *
   * Multipart form fields:
   *   - `file`     : the .docx file (required)
   *   - `name`     : document name override (optional; defaults to filename)
   *   - `clientId` : link the new document to a client (optional)
   *
   * Returns:
   *   201 { document, report }  — report describes anything skipped/simplified
   *   400 missing file / bad client, 413 too large, 415 wrong type,
   *   422 unreadable file, 500 unexpected.
   *
   * DB-hold rule (same as Sheets): conversion completes fully BEFORE the
   * single INSERT — no DB connection is held across the CPU-bound parse.
   */
  app.post(
    "/api/docs/documents/import",
    isAuthenticated,
    requireAccountManager,
    uploadLimiter,
    (req, res, next) => {
      docsImportUpload.single("file")(req, res, (err) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              error: "File too large",
              message: `The file must be under ${Math.round(DOCS_IMPORT_MAX_FILE_BYTES / 1024 / 1024)} MB.`,
            });
          }
          return res.status(415).json({
            error: "Unsupported file type",
            message: err.message ?? "Only .docx files are supported.",
          });
        }
        next();
      });
    },
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;

        if (!req.file) {
          return res.status(400).json({
            error: "No file uploaded",
            message: "Please include a file field named 'file'.",
          });
        }

        const originalName: string = req.file.originalname ?? "import.docx";
        const baseName = originalName.replace(/\.[^.]+$/, "").trim() || "Imported Document";

        const bodyName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
        const documentName = (bodyName || baseName).slice(0, 255);

        const clientRef = await resolveClientId(req.body?.clientId);
        if (!clientRef.ok) {
          return res.status(400).json({ error: "Client not found" });
        }

        // ── Convert (no DB hold) ────────────────────────────────────────────
        let convResult;
        try {
          convResult = await convertDocxToDocumentSnapshot(req.file.buffer, documentName);
        } catch (convErr: any) {
          return res.status(422).json({
            error: "Import failed",
            message: convErr?.message ?? "The file could not be converted.",
          });
        }
        const { snapshot, report } = convResult;

        const snapBytes = snapshotBytes(snapshot);
        if (snapBytes > SNAPSHOT_MAX_BYTES) {
          return res.status(413).json({
            error: "Converted document too large",
            message: `The resulting document is ${Math.round(snapBytes / 1024 / 1024)} MB, which exceeds the 10 MB limit.`,
          });
        }

        // ── DB write (snapshot fully built before entering hold) ───────────
        const document = await storage.createDocDocument({
          name: documentName,
          ownerId: userId,
          clientId: clientRef.clientId,
          snapshot: snapshot as any,
        });

        logActivity({
          documentId: document.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "imported",
          detail: { source: "file", originalName, format: "docx" },
        });
        res.status(201).json({ document, report });
      } catch (err: any) {
        console.error("[docs] importDocument failed:", err?.message ?? err);
        res.status(500).json({ error: "Import failed due to a server error." });
      }
    },
  );

  /**
   * GET /api/docs/documents/:id/export/docx
   * Download the document as a .docx attachment. Any reader may export.
   */
  app.get(
    "/api/docs/documents/:id/export/docx",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        const userId: string = req.user.claims.sub;
        const userRole = callerRole(req);
        const document = await storage.getDocDocument(req.params.id);
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!(await accessLevel(document, userId, userRole))) {
          return res.status(403).json({ error: "Forbidden" });
        }

        if (!document.snapshot) {
          return res.status(422).json({ error: "This document has no content to export." });
        }

        let docxBuf: Buffer;
        try {
          docxBuf = await convertDocumentSnapshotToDocx(document.snapshot, document.name);
        } catch (convErr: any) {
          return res.status(422).json({
            error: "Export failed",
            message: convErr?.message ?? "The document could not be converted.",
          });
        }

        const safeName = document.name.replace(/[^\w\s-]/g, "").trim() || "document";
        logActivity({
          documentId: req.params.id,
          actorId: userId,
          actorName: callerDisplayName(req),
          action: "exported",
          detail: { format: "docx" },
        });
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        );
        res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.docx"`);
        res.setHeader("Content-Length", docxBuf.length);
        res.send(docxBuf);
      } catch (err: any) {
        console.error("[docs] exportDocx failed:", err?.message ?? err);
        res.status(500).json({ error: "Export failed due to a server error." });
      }
    },
  );
}
