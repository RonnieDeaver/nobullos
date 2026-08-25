/**
 * Task #4023 — In-app client file storage & manager (routes).
 *
 * Drive-style file space per client on the app's private object storage:
 * folders, presigned multi-upload with claim-time verification, previews,
 * rename/move/bulk ops, same-name versioning with restore, per-client Trash
 * with retention purge, activity log, plus a global cross-client library.
 *
 * Access model:
 *   • Per-client routes — authenticated staff whose legacy role is
 *     account_manager+ OR the client's owner (mirrors save-plays/judgments).
 *   • Global library (/api/files, /api/files/recent) — account_manager+.
 *   • Storage-usage rollup (/api/files/usage) — team_lead+.
 *
 * Upload/claim flow (mirrors feedback attachments, Task #3964):
 *   mint → browser PUTs directly to signed URL → claim: namespace +
 *   unclaimed-or-self ACL gate (clientFileClaimAllowed) → content
 *   verification (size cap + magic-byte sniff + metadata laundering via
 *   verifyClientFileObjectContent) → rejected objects deleted race-safely →
 *   ACL owner stamped → DB row upserted (same name ⇒ prior version kept).
 *
 * Serving: our own authenticated streaming route sets headers from the
 * DB-stored (sniff-derived) mime only — never uploader metadata. Inline
 * rendering requires BOTH the client asking disposition=inline AND the mime
 * being on the INLINE_PREVIEW_MIMES whitelist (no html/svg/xml — stored
 * markup must never execute on our origin). Everything else downloads as an
 * attachment with X-Content-Type-Options: nosniff.
 *
 * All DB work lives in server/services/clientFileService.ts; this file maps
 * HTTP ⇄ service and owns the storage side (streams, zip bundling, object
 * deletes for purge). Storage is injectable so route tests exercise the REAL
 * handlers without talking to object storage.
 */
import type { Express, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { Zip, ZipPassThrough } from "fflate";
import { isAuthenticated } from "../middlewares/requireAuth";
import { hasRole, requireAccountManager, requireTeamLead } from "./middleware";
import { storage as appStorage } from "../storage";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../replit_integrations/object_storage/objectStorage";
import type { GeneralUploadVerdict } from "../replit_integrations/object_storage/generalUploadSniff";
import {
  CLIENT_FILE_MAX_BYTES,
  CLIENT_FILE_SHARE_DEFAULT_DAYS,
  CLIENT_FILE_SHARE_MAX_DAYS,
  CLIENT_FILE_SHARE_TOKEN_BYTES,
  CLIENT_FILE_ZIP_MAX_TOTAL_BYTES,
  CLIENT_FILE_KINDS,
  isShareTokenShaped,
  shareLinkPath,
  shareLinkStatus,
  clientFileClaimAllowed,
  fileNameExtension,
  isInlinePreviewableMime,
  inlineServingMime,
  sanitizeClientFileName,
  splitClientFileName,
  type ClientFileKind,
} from "@shared/clientFiles";
import {
  ClientFileError,
  browseFolder,
  claimUploadedFile,
  clientUsage,
  createShareLink,
  getShareByTokenHash,
  listShareLinks,
  recordShareAccess,
  replaceShareLink,
  revokeShareLink,
  allClientsUsage,
  createFolder,
  deleteFolder,
  getFile,
  getClientLite,
  listAllFolders,
  listClientActivity,
  listFileActivity,
  listPurgeTargets,
  listTrash,
  listVersions,
  logDownload,
  moveFolder,
  moveFiles,
  purgeFileRows,
  renameFile,
  renameFolder,
  restoreFiles,
  restoreVersion,
  searchFiles,
  trashFiles,
  type FileActor,
  type PurgeTarget,
} from "../services/clientFileService";

// ── Injectable storage seam (tests provide a fake) ─────────────────────────

export interface ClientFileStorage {
  getClientFileUploadURL(
    clientId: string,
    opts?: { extension?: string | null },
  ): Promise<{ uploadUrl: string; objectPath: string }>;
  getObjectEntityAclPolicy(
    objectPath: string,
  ): Promise<{ owner?: string | null } | null | undefined>;
  verifyClientFileObjectContent(
    objectPath: string,
    opts: { maxBytes: number; fileName?: string },
  ): Promise<GeneralUploadVerdict>;
  trySetObjectEntityAclPolicy(
    objectPath: string,
    policy: { owner: string; visibility: "private" },
  ): Promise<unknown>;
  deleteRejectedUploadObject(
    objectPath: string,
    opts: { expectedOwner: string | null },
  ): Promise<boolean>;
  deletePrivateObjectByKey(objectKey: string): Promise<boolean>;
  createPrivateObjectReadStream(
    objectKey: string,
  ): Promise<NodeJS.ReadableStream>;
}

export interface ClientFileRoutesDeps {
  storage?: ClientFileStorage;
}

// ── Request schemas ─────────────────────────────────────────────────────────

const idSchema = z.string().trim().min(1).max(100);

const uploadUrlSchema = z
  .object({
    fileName: z.string().trim().min(1).max(300),
  })
  .strict();

const claimSchema = z
  .object({
    objectPath: z.string().trim().min(1).max(500),
    fileName: z.string().trim().min(1).max(300),
    folderId: idSchema.nullish(),
  })
  .strict();

const createFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    parentId: idSchema.nullish(),
  })
  .strict();

const patchFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(300).optional(),
    parentId: idSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.parentId !== undefined, {
    message: "Provide name (rename) or parentId (move)",
  });

const renameFileSchema = z
  .object({ name: z.string().trim().min(1).max(300) })
  .strict();

const fileIdsSchema = z
  .object({ fileIds: z.array(idSchema).min(1).max(200) })
  .strict();

const moveFilesSchema = z
  .object({
    fileIds: z.array(idSchema).min(1).max(200),
    folderId: idSchema.nullable(),
  })
  .strict();

const createShareSchema = z
  .object({
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(CLIENT_FILE_SHARE_MAX_DAYS)
      .optional(),
  })
  .strict();

const FILE_KINDS: readonly ClientFileKind[] = CLIENT_FILE_KINDS;

const searchQuerySchema = z.object({
  q: z.string().trim().max(300).optional(),
  kind: z
    .string()
    .optional()
    .transform((v) => (FILE_KINDS.includes(v as ClientFileKind) ? (v as ClientFileKind) : undefined)),
  sort: z.enum(["name", "size", "modified", "client", "folder"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapError(res: Response, err: unknown, logPrefix: string): void {
  if (err instanceof ClientFileError) {
    const status =
      err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ObjectNotFoundError) {
    res.status(404).json({ error: "File content not found" });
    return;
  }
  console.error(`${logPrefix}:`, (err as any)?.message ?? err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal error" });
  }
}

function actorNameOf(user: any): string {
  const name = [user?.firstName, user?.lastName]
    .filter((p: unknown) => typeof p === "string" && p)
    .join(" ")
    .trim();
  return name || user?.email || "Unknown";
}

/** RFC 6266/5987 Content-Disposition with a safe ASCII fallback. */
export function contentDispositionHeader(
  kind: "inline" | "attachment",
  fileName: string,
): string {
  const fallback =
    fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * Minimal static page for dead/invalid share links — deliberately free of
 * any user-controlled content (no file names) so nothing needs escaping.
 */
function shareGonePage(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f8f7f5;margin:0;
    display:flex;align-items:center;justify-content:center;min-height:100vh;color:#334155}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:40px 48px;
    max-width:420px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  /* COLOR DECISION (Task #4567) — ALIGNED to Liberty Blue #485696 (was
     legacy burgundy #6B2C3E, retired from the brand). This is a neutral
     informational notice, not an error/danger state; Liberty on white is
     6.89:1 (AA). */
  h1{font-size:18px;margin:0 0 8px;color:#485696}
  p{font-size:14px;margin:0;color:#64748b}
</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`);
}

/** Zip entry names must be unique — "a.pdf" → "a (2).pdf" on collision. */
function uniqueZipName(used: Set<string>, name: string): string {
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const { base, ext } = splitClientFileName(name);
    candidate = `${base} (${n})${ext}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function registerClientFileRoutes(
  app: Express,
  deps: ClientFileRoutesDeps = {},
): void {
  const objectStorage: ClientFileStorage =
    deps.storage ?? new ObjectStorageService();

  /**
   * Shared per-client access check (mirrors save-plays/daily-judgments):
   * 404 for a missing client, 403 unless account_manager+ role or the
   * client's owner. Returns null after writing the response on denial;
   * otherwise the ids + resolved actor for activity attribution.
   */
  async function authorizeClientAccess(
    req: Request,
    res: Response,
  ): Promise<{ clientId: string; userId: string; actor: FileActor } | null> {
    const clientId = (req.params as any).clientId as string;
    const client = await getClientLite(clientId);
    if (!client) {
      res.status(404).json({ error: "Client not found" });
      return null;
    }
    const userId = (req as any).user?.claims?.sub as string;
    const user = await appStorage.getUser(userId);
    if (!hasRole(user?.role, "account_manager") && client.ownerId !== userId) {
      res.status(403).json({ error: "Access denied" });
      return null;
    }
    return { clientId, userId, actor: { id: userId, name: actorNameOf(user) } };
  }

  /** Objects first, rows second — see clientFileTrashPurge.ts header. */
  async function purgeTargetsNow(
    clientId: string,
    targets: PurgeTarget[],
    actor: FileActor,
  ): Promise<{ purged: number; failed: number }> {
    const cleared: { fileId: string; name: string; totalBytes: number }[] = [];
    for (const target of targets) {
      let allGone = true;
      for (const key of target.objectKeys) {
        try {
          await objectStorage.deletePrivateObjectByKey(key);
        } catch (err: any) {
          allGone = false;
          console.warn(
            `[ClientFiles] Purge delete failed for ${key}: ${err?.message ?? err}`,
          );
        }
      }
      if (allGone) {
        cleared.push({
          fileId: target.fileId,
          name: target.name,
          totalBytes: target.totalBytes,
        });
      }
    }
    const { purged } = await purgeFileRows({
      clientId,
      files: cleared,
      actor,
      via: "manual",
    });
    return { purged, failed: targets.length - cleared.length };
  }

  /** Stream one stored object with DB-derived headers (never object meta). */
  async function streamStoredObject(
    res: Response,
    args: {
      objectKey: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      wantInline: boolean;
    },
  ): Promise<void> {
    const inline = args.wantInline && isInlinePreviewableMime(args.mimeType);
    const contentType = inline
      ? inlineServingMime(args.mimeType)
      : args.mimeType || "application/octet-stream";
    const stream = await objectStorage.createPrivateObjectReadStream(
      args.objectKey,
    );
    res.set({
      "Content-Type": contentType,
      "Content-Length": String(args.sizeBytes),
      "Content-Disposition": contentDispositionHeader(
        inline ? "inline" : "attachment",
        args.fileName,
      ),
      "X-Content-Type-Options": "nosniff",
      // Version restore swaps bytes under the same URL — never cache.
      "Cache-Control": "private, no-store",
    });
    stream.on("error", (err: any) => {
      console.error(
        `[ClientFiles] Stream error for ${args.objectKey}: ${err?.message ?? err}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "Error streaming file" });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }

  const base = "/api/clients/:clientId/files";

  // ── Upload: mint presigned URL ────────────────────────────────────────────
  app.post(`${base}/upload-url`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = uploadUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const fileName = sanitizeClientFileName(parsed.data.fileName);
      if (!fileName) {
        res.status(400).json({ error: "Invalid file name" });
        return;
      }
      const { uploadUrl, objectPath } = await objectStorage.getClientFileUploadURL(
        auth.clientId,
        { extension: fileNameExtension(fileName) },
      );
      res.json({ uploadUrl, objectPath, maxBytes: CLIENT_FILE_MAX_BYTES });
    } catch (err) {
      mapError(res, err, "[ClientFiles] upload-url failed");
    }
  });

  // ── Upload: claim after the browser PUT ───────────────────────────────────
  app.post(`${base}/claim`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const fileName = sanitizeClientFileName(parsed.data.fileName);
      if (!fileName) {
        res.status(400).json({ error: "Invalid file name" });
        return;
      }
      const objectPath = parsed.data.objectPath;

      // 1. Namespace + ownership gate BEFORE anything else: the path must be
      //    inside THIS client's namespace and the object unclaimed or already
      //    this user's own (shared, unit-testable decision).
      let existingOwner: string | null | undefined;
      try {
        const acl = await objectStorage.getObjectEntityAclPolicy(objectPath);
        existingOwner = acl?.owner;
      } catch (err) {
        if (err instanceof ObjectNotFoundError) {
          res.status(400).json({ error: "Uploaded object not found" });
          return;
        }
        throw err;
      }
      const gate = clientFileClaimAllowed({
        objectPath,
        clientId: auth.clientId,
        currentOwner: existingOwner,
        claimantUserId: auth.userId,
      });
      if (!gate.allowed) {
        console.warn(
          `[ClientFiles] Rejected claim (${gate.reason}): ${objectPath} by ${auth.userId}`,
        );
        res.status(403).json({ error: "Upload cannot be claimed" });
        return;
      }

      // 2. Verify stored bytes BEFORE taking ownership (size cap + sniff +
      //    contentType laundering). Rejected objects are deleted race-safely
      //    — the gate above proved unclaimed-or-self, so the delete can never
      //    destroy someone else's object.
      const verdict = await objectStorage.verifyClientFileObjectContent(
        objectPath,
        { maxBytes: CLIENT_FILE_MAX_BYTES, fileName },
      );
      if (!verdict.ok) {
        console.warn(
          `[ClientFiles] Rejected upload (${verdict.reason}): ${objectPath} — ${verdict.detail}`,
        );
        await objectStorage.deleteRejectedUploadObject(objectPath, {
          expectedOwner: auth.userId,
        });
        res.status(400).json({
          error:
            verdict.reason === "too_large"
              ? `File exceeds the ${Math.round(CLIENT_FILE_MAX_BYTES / (1024 * 1024))} MB limit`
              : "Uploaded file is empty",
        });
        return;
      }

      // 3. Stamp ownership, then persist (same-name ⇒ prior version kept).
      await objectStorage.trySetObjectEntityAclPolicy(objectPath, {
        owner: auth.userId,
        visibility: "private",
      });
      const result = await claimUploadedFile({
        clientId: auth.clientId,
        folderId: parsed.data.folderId ?? null,
        name: fileName,
        objectKey: gate.objectKey,
        mimeType: verdict.mime,
        sizeBytes: verdict.sizeBytes,
        actor: auth.actor,
      });
      res.status(201).json(result);
    } catch (err) {
      mapError(res, err, "[ClientFiles] claim failed");
    }
  });

  // ── Browse / search / trash / tree / usage / activity ───────────────────
  app.get(`${base}/browse`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const folderId =
        typeof req.query.folderId === "string" && req.query.folderId
          ? req.query.folderId
          : null;
      res.json(await browseFolder(auth.clientId, folderId));
    } catch (err) {
      mapError(res, err, "[ClientFiles] browse failed");
    }
  });

  app.get(`${base}/search`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const q = searchQuerySchema.safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: "Invalid search parameters" });
        return;
      }
      res.json(await searchFiles({ ...q.data, clientId: auth.clientId }));
    } catch (err) {
      mapError(res, err, "[ClientFiles] search failed");
    }
  });

  app.get(`${base}/trash`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      res.json({ files: await listTrash(auth.clientId) });
    } catch (err) {
      mapError(res, err, "[ClientFiles] trash list failed");
    }
  });

  app.get(`${base}/tree`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      res.json({ folders: await listAllFolders(auth.clientId) });
    } catch (err) {
      mapError(res, err, "[ClientFiles] tree failed");
    }
  });

  app.get(`${base}/usage`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      res.json(await clientUsage(auth.clientId));
    } catch (err) {
      mapError(res, err, "[ClientFiles] usage failed");
    }
  });

  app.get(`${base}/activity`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      res.json({ activity: await listClientActivity(auth.clientId, limit) });
    } catch (err) {
      mapError(res, err, "[ClientFiles] activity failed");
    }
  });

  // ── Folder CRUD ───────────────────────────────────────────────────────────
  app.post(`${base}/folders`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = createFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const name = sanitizeClientFileName(parsed.data.name);
      if (!name) {
        res.status(400).json({ error: "Invalid folder name" });
        return;
      }
      const folder = await createFolder({
        clientId: auth.clientId,
        parentId: parsed.data.parentId ?? null,
        name,
        actor: auth.actor,
      });
      res.status(201).json(folder);
    } catch (err) {
      mapError(res, err, "[ClientFiles] create folder failed");
    }
  });

  app.patch(`${base}/folders/:folderId`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = patchFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const folderId = req.params.folderId as string;
      if (parsed.data.name !== undefined) {
        const name = sanitizeClientFileName(parsed.data.name);
        if (!name) {
          res.status(400).json({ error: "Invalid folder name" });
          return;
        }
        res.json(
          await renameFolder({
            clientId: auth.clientId,
            folderId,
            name,
            actor: auth.actor,
          }),
        );
        return;
      }
      res.json(
        await moveFolder({
          clientId: auth.clientId,
          folderId,
          newParentId: parsed.data.parentId ?? null,
          actor: auth.actor,
        }),
      );
    } catch (err) {
      mapError(res, err, "[ClientFiles] folder update failed");
    }
  });

  app.delete(`${base}/folders/:folderId`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const result = await deleteFolder({
        clientId: auth.clientId,
        folderId: req.params.folderId as string,
        actor: auth.actor,
      });
      res.json(result);
    } catch (err) {
      mapError(res, err, "[ClientFiles] folder delete failed");
    }
  });

  // ── Bulk file operations (static paths BEFORE /:fileId) ─────────────────
  app.post(`${base}/move`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = moveFilesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      res.json(
        await moveFiles({
          clientId: auth.clientId,
          fileIds: parsed.data.fileIds,
          folderId: parsed.data.folderId,
          actor: auth.actor,
        }),
      );
    } catch (err) {
      mapError(res, err, "[ClientFiles] move failed");
    }
  });

  app.post(`${base}/trash-files`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = fileIdsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      res.json(
        await trashFiles({
          clientId: auth.clientId,
          fileIds: parsed.data.fileIds,
          actor: auth.actor,
        }),
      );
    } catch (err) {
      mapError(res, err, "[ClientFiles] trash failed");
    }
  });

  app.post(`${base}/restore`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = fileIdsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      res.json(
        await restoreFiles({
          clientId: auth.clientId,
          fileIds: parsed.data.fileIds,
          actor: auth.actor,
        }),
      );
    } catch (err) {
      mapError(res, err, "[ClientFiles] restore failed");
    }
  });

  app.post(`${base}/purge`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = fileIdsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const targets = await listPurgeTargets(auth.clientId, parsed.data.fileIds);
      res.json(await purgeTargetsNow(auth.clientId, targets, auth.actor));
    } catch (err) {
      mapError(res, err, "[ClientFiles] purge failed");
    }
  });

  // Bounded per call so an enormous trash cannot hold a request open for
  // minutes — the client repeats while `remaining > 0`.
  app.post(`${base}/empty-trash`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const all = await listPurgeTargets(auth.clientId);
      const batch = all.slice(0, 200);
      const result = await purgeTargetsNow(auth.clientId, batch, auth.actor);
      res.json({ ...result, remaining: all.length - batch.length });
    } catch (err) {
      mapError(res, err, "[ClientFiles] empty-trash failed");
    }
  });

  // ── Bulk zip download ─────────────────────────────────────────────────────
  app.post(`${base}/zip`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = fileIdsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const files = [];
      for (const fileId of parsed.data.fileIds) {
        const file = await getFile(auth.clientId, fileId);
        if (file && !file.trashedAt) files.push(file);
      }
      if (files.length === 0) {
        res.status(404).json({ error: "No downloadable files selected" });
        return;
      }
      const totalBytes = files.reduce((sum, f) => sum + Number(f.sizeBytes || 0), 0);
      if (totalBytes > CLIENT_FILE_ZIP_MAX_TOTAL_BYTES) {
        res.status(413).json({
          error: `Selection exceeds the ${Math.round(CLIENT_FILE_ZIP_MAX_TOTAL_BYTES / (1024 * 1024 * 1024))} GB zip limit — download in smaller batches`,
        });
        return;
      }

      const client = await getClientLite(auth.clientId);
      const zipName =
        sanitizeClientFileName(`${client?.firmName ?? "client"} files.zip`) ||
        "client files.zip";
      res.set({
        "Content-Type": "application/zip",
        "Content-Disposition": contentDispositionHeader("attachment", zipName),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });

      let failed = false;
      const zip = new Zip((err, chunk, final) => {
        if (err) {
          failed = true;
          console.error(`[ClientFiles] Zip error: ${err.message ?? err}`);
          res.destroy();
          return;
        }
        res.write(Buffer.from(chunk));
        if (final) res.end();
      });

      const usedNames = new Set<string>();
      for (const file of files) {
        if (failed || res.destroyed) break;
        // ZipPassThrough = store (no re-compression): most stored assets are
        // already compressed and CPU stays flat for multi-hundred-MB pulls.
        const entry = new ZipPassThrough(uniqueZipName(usedNames, file.name));
        zip.add(entry);
        try {
          const stream = await objectStorage.createPrivateObjectReadStream(
            file.objectKey,
          );
          await new Promise<void>((resolve, reject) => {
            stream.on("data", (chunk: Buffer) =>
              entry.push(new Uint8Array(chunk)),
            );
            stream.on("end", () => {
              entry.push(new Uint8Array(0), true);
              resolve();
            });
            stream.on("error", reject);
          });
          await logDownload({
            clientId: auth.clientId,
            fileId: file.id,
            name: file.name,
            actor: auth.actor,
            disposition: "zip",
          }).catch(() => {});
        } catch (err: any) {
          // A vanished object mid-zip corrupts the archive if we just skip
          // the entry we already added — abort explicitly instead.
          failed = true;
          console.error(
            `[ClientFiles] Zip stream failed for ${file.objectKey}: ${err?.message ?? err}`,
          );
          res.destroy();
        }
      }
      if (!failed && !res.destroyed) zip.end();
    } catch (err) {
      mapError(res, err, "[ClientFiles] zip failed");
    }
  });

  // ── Single-file routes (AFTER all static segments) ───────────────────────
  app.get(`${base}/:fileId`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const fileId = req.params.fileId as string;
      const file = await getFile(auth.clientId, fileId);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const [versions, activity] = await Promise.all([
        listVersions(auth.clientId, fileId),
        listFileActivity(auth.clientId, fileId, 100),
      ]);
      res.json({ file, versions, activity });
    } catch (err) {
      mapError(res, err, "[ClientFiles] file detail failed");
    }
  });

  app.get(`${base}/:fileId/download`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const file = await getFile(auth.clientId, req.params.fileId as string);
      if (!file) {
        res.status(404).json({ error: "File not found" });
        return;
      }
      const wantInline = req.query.disposition === "inline";
      await logDownload({
        clientId: auth.clientId,
        fileId: file.id,
        name: file.name,
        actor: auth.actor,
        disposition: wantInline ? "inline" : "attachment",
      }).catch(() => {});
      await streamStoredObject(res, {
        objectKey: file.objectKey,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: Number(file.sizeBytes),
        wantInline,
      });
    } catch (err) {
      mapError(res, err, "[ClientFiles] download failed");
    }
  });

  app.get(
    `${base}/:fileId/versions/:versionId/download`,
    isAuthenticated,
    async (req: any, res) => {
      try {
        const auth = await authorizeClientAccess(req, res);
        if (!auth) return;
        const fileId = req.params.fileId as string;
        const file = await getFile(auth.clientId, fileId);
        if (!file) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        const versions = await listVersions(auth.clientId, fileId);
        const version = versions.find((v) => v.id === req.params.versionId);
        if (!version) {
          res.status(404).json({ error: "Version not found" });
          return;
        }
        const wantInline = req.query.disposition === "inline";
        await streamStoredObject(res, {
          objectKey: version.objectKey,
          fileName: file.name,
          mimeType: version.mimeType,
          sizeBytes: Number(version.sizeBytes),
          wantInline,
        });
      } catch (err) {
        mapError(res, err, "[ClientFiles] version download failed");
      }
    },
  );

  app.post(
    `${base}/:fileId/versions/:versionId/restore`,
    isAuthenticated,
    async (req: any, res) => {
      try {
        const auth = await authorizeClientAccess(req, res);
        if (!auth) return;
        res.json(
          await restoreVersion({
            clientId: auth.clientId,
            fileId: req.params.fileId as string,
            versionId: req.params.versionId as string,
            actor: auth.actor,
          }),
        );
      } catch (err) {
        mapError(res, err, "[ClientFiles] version restore failed");
      }
    },
  );

  // ── External share links (Task #4028) ───────────────────────────────────
  app.post(`${base}/:fileId/shares`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = createShareSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const days = parsed.data.expiresInDays ?? CLIENT_FILE_SHARE_DEFAULT_DAYS;
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      // Raw token exists only in this response; the DB keeps its sha256.
      const token = randomBytes(CLIENT_FILE_SHARE_TOKEN_BYTES).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const share = await createShareLink({
        clientId: auth.clientId,
        fileId: req.params.fileId as string,
        tokenHash,
        expiresAt,
        actor: auth.actor,
      });
      res.status(201).json({ share, token, path: shareLinkPath(token) });
    } catch (err) {
      mapError(res, err, "[ClientFiles] share create failed");
    }
  });

  app.get(`${base}/:fileId/shares`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      res.json({
        shares: await listShareLinks(auth.clientId, req.params.fileId as string),
      });
    } catch (err) {
      mapError(res, err, "[ClientFiles] share list failed");
    }
  });

  // Task #4040 — replace an active link: revoke + re-mint in one transaction.
  // Raw tokens are unrecoverable (DB keeps only the sha256), so this is the
  // re-copy path for a lost link. The new token keeps the old expiry.
  app.post(
    `${base}/:fileId/shares/:shareId/replace`,
    isAuthenticated,
    async (req: any, res) => {
      try {
        const auth = await authorizeClientAccess(req, res);
        if (!auth) return;
        // Raw token exists only in this response; the DB keeps its sha256.
        const token = randomBytes(CLIENT_FILE_SHARE_TOKEN_BYTES).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const share = await replaceShareLink({
          clientId: auth.clientId,
          fileId: req.params.fileId as string,
          shareId: req.params.shareId as string,
          tokenHash,
          actor: auth.actor,
        });
        res.status(201).json({ share, token, path: shareLinkPath(token) });
      } catch (err) {
        mapError(res, err, "[ClientFiles] share replace failed");
      }
    },
  );

  app.delete(
    `${base}/:fileId/shares/:shareId`,
    isAuthenticated,
    async (req: any, res) => {
      try {
        const auth = await authorizeClientAccess(req, res);
        if (!auth) return;
        res.json(
          await revokeShareLink({
            clientId: auth.clientId,
            fileId: req.params.fileId as string,
            shareId: req.params.shareId as string,
            actor: auth.actor,
          }),
        );
      } catch (err) {
        mapError(res, err, "[ClientFiles] share revoke failed");
      }
    },
  );

  /**
   * PUBLIC token-gated download — the only unauthenticated client-file
   * surface. The 256-bit token is the whole credential: shape-check, hash,
   * exact-match lookup, then the expiry/revocation/trash gate. Valid links
   * stream through the same DB-derived-header path as staff downloads
   * (never a raw bucket URL); anything else gets a clean static page with
   * zero user-controlled content.
   */
  app.get("/share/file/:token", async (req, res) => {
    try {
      const token = req.params.token;
      if (!isShareTokenShaped(token)) {
        shareGonePage(res, 404, "Link not found", "This share link isn't valid. Check that the full link was copied.");
        return;
      }
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const resolved = await getShareByTokenHash(tokenHash);
      if (!resolved) {
        shareGonePage(res, 404, "Link not found", "This share link isn't valid. Check that the full link was copied.");
        return;
      }
      const { share, file } = resolved;
      if (shareLinkStatus(share) !== "active" || file.trashedAt) {
        shareGonePage(res, 410, "Link expired", "This share link has expired or was revoked. Ask the sender for a fresh link.");
        return;
      }
      await recordShareAccess({
        shareId: share.id,
        clientId: share.clientId,
        fileId: file.id,
        fileName: file.name,
      }).catch((err: any) => {
        console.warn(`[ClientFiles] share access log failed: ${err?.message ?? err}`);
      });
      await streamStoredObject(res, {
        objectKey: file.objectKey,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: Number(file.sizeBytes),
        // Previewable types render in the recipient's browser; ?download=1
        // forces the attachment disposition. Non-whitelisted mimes always
        // download (streamStoredObject enforces the inline whitelist).
        wantInline: req.query.download !== "1",
      });
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        shareGonePage(res, 410, "Link expired", "This file is no longer available.");
        return;
      }
      console.error(`[ClientFiles] share download failed:`, (err as any)?.message ?? err);
      if (!res.headersSent) {
        shareGonePage(res, 500, "Something went wrong", "Please try again in a moment.");
      }
    }
  });

  app.patch(`${base}/:fileId`, isAuthenticated, async (req: any, res) => {
    try {
      const auth = await authorizeClientAccess(req, res);
      if (!auth) return;
      const parsed = renameFileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
        return;
      }
      const name = sanitizeClientFileName(parsed.data.name);
      if (!name) {
        res.status(400).json({ error: "Invalid file name" });
        return;
      }
      res.json(
        await renameFile({
          clientId: auth.clientId,
          fileId: req.params.fileId as string,
          name,
          actor: auth.actor,
        }),
      );
    } catch (err) {
      mapError(res, err, "[ClientFiles] rename failed");
    }
  });

  // ── Global library ──────────────────────────────────────────────────────
  app.get("/api/files", isAuthenticated, requireAccountManager, async (req: any, res) => {
    try {
      const q = searchQuerySchema
        .extend({ clientId: idSchema.optional() })
        .safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: "Invalid search parameters" });
        return;
      }
      res.json(await searchFiles(q.data));
    } catch (err) {
      mapError(res, err, "[ClientFiles] global search failed");
    }
  });

  app.get(
    "/api/files/recent",
    isAuthenticated,
    requireAccountManager,
    async (req: any, res) => {
      try {
        // Task #4488 — the Files library pages/sorts "recent" server-side.
        // Defaults preserve the legacy shape (12 most recently modified).
        const parsed = searchQuerySchema
          .omit({ q: true, kind: true })
          .safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid list parameters" });
          return;
        }
        res.json(
          await searchFiles({
            sort: parsed.data.sort ?? "modified",
            dir: parsed.data.dir ?? "desc",
            limit: Math.min(parsed.data.limit ?? 12, 200),
            offset: parsed.data.offset ?? 0,
          }),
        );
      } catch (err) {
        mapError(res, err, "[ClientFiles] recent failed");
      }
    },
  );

  app.get(
    "/api/files/usage",
    isAuthenticated,
    requireTeamLead,
    async (_req: any, res) => {
      try {
        res.json(await allClientsUsage());
      } catch (err) {
        mapError(res, err, "[ClientFiles] usage rollup failed");
      }
    },
  );
}
