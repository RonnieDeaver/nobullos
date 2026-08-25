/**
 * Task #2657 — admin-only ("/admin/backups") app-backup routes.
 *
 * Every endpoint is gated by `isAuthenticated` plus a strict CEO check
 * (mirrors `server/routes/prodActions.ts` — `getAssignedAuthority` so the
 * gate bypasses permissive-mode). The page lists backup runs, downloads the
 * gzipped DB dump or file manifest for a run, and triggers an on-demand
 * backup.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { isAuthenticated } from "../middlewares/requireAuth";
import { getAssignedAuthority } from "../auth/permissions";
import { storage } from "../storage";
import { runWithWorkerDb } from "../db";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../replit_integrations/object_storage";
import { runAppBackup, BackupNotInDeploymentError } from "../services/appBackup";

/**
 * Strict CEO gate — bypasses `role_permissions_permissive_mode`. Non-CEO
 * users get a hard 403.
 */
async function requireCeo(req: any, res: Response, next: NextFunction) {
  try {
    const userId: string | undefined = req.user?.claims?.sub;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const user = await storage.getUser(userId);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (getAssignedAuthority(user) !== "ceo") {
      return res.status(403).json({ error: "Forbidden — CEO only" });
    }
    (req as any).ceoUser = user;
    next();
  } catch (err: any) {
    console.error("[backups] auth check failed:", err?.message ?? err);
    res.status(500).json({ error: "Internal error" });
  }
}

export function registerBackupsRoutes(app: Express): void {
  // List backup runs (most recent first).
  app.get(
    "/api/admin/backups",
    isAuthenticated,
    requireCeo,
    async (req: Request, res: Response) => {
      try {
        const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(limitRaw, 1), 500)
          : 100;
        const runs = await runWithWorkerDb(() => storage.listAppBackupRuns(limit));
        res.json({ runs });
      } catch (err: any) {
        console.error("[backups] list failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to list backups" });
      }
    },
  );

  // Trigger an on-demand backup. Runs synchronously through the worker pool;
  // returns the finalized run row so the UI reflects the outcome immediately.
  app.post(
    "/api/admin/backups/run",
    isAuthenticated,
    requireCeo,
    async (req: Request, res: Response) => {
      try {
        const triggeredBy: string | null = (req as any).user?.claims?.sub ?? null;
        const result = await runWithWorkerDb(() =>
          runAppBackup({ kind: "manual", triggeredBy }),
        );
        const run = await runWithWorkerDb(() => storage.getAppBackupRun(result.runId));
        res.json({ run, status: result.status });
      } catch (err: any) {
        // A backup targets prod and only runs in the deployment — a workspace
        // press would dump the dev DB, so refuse with a clear 409.
        if (err instanceof BackupNotInDeploymentError) {
          return res.status(409).json({ error: err.message });
        }
        console.error("[backups] manual run failed:", err?.message ?? err);
        res.status(500).json({ error: "Failed to run backup" });
      }
    },
  );

  // Download the gzipped Postgres dump for a run.
  app.get(
    "/api/admin/backups/:id/download/db",
    isAuthenticated,
    requireCeo,
    (req: Request, res: Response) =>
      streamBackupArtifact(req, res, "db"),
  );

  // Download the gzipped file manifest for a run.
  app.get(
    "/api/admin/backups/:id/download/manifest",
    isAuthenticated,
    requireCeo,
    (req: Request, res: Response) =>
      streamBackupArtifact(req, res, "manifest"),
  );
}

async function streamBackupArtifact(
  req: Request,
  res: Response,
  which: "db" | "manifest",
): Promise<void> {
  try {
    const id = req.params.id;
    const run = await runWithWorkerDb(() => storage.getAppBackupRun(id));
    if (!run) {
      res.status(404).json({ error: "Backup run not found" });
      return;
    }
    const key = which === "db" ? run.dbDumpKey : run.fileManifestKey;
    if (!key) {
      res.status(404).json({
        error:
          which === "db"
            ? "This run has no database dump"
            : "This run has no file manifest",
      });
      return;
    }
    const objectStorage = new ObjectStorageService();
    let file;
    try {
      file = await objectStorage.getPrivateObjectFileByKey(key);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Backup artifact no longer exists" });
        return;
      }
      throw err;
    }
    const downloadName =
      which === "db"
        ? `backup-${run.id}-database.sql.gz`
        : `backup-${run.id}-file-manifest.json.gz`;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName}"`,
    );
    // Private artifact — no shared caching.
    await objectStorage.downloadObject(file, res, 0);
  } catch (err: any) {
    console.error(`[backups] download ${which} failed:`, err?.message ?? err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to download backup artifact" });
    }
  }
}
