import type { Express, Request, Response } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { ObjectPermission, getObjectAclPolicy, type ObjectAclPolicy } from "./objectAcl";
import { isAuthenticated } from "../../middlewares/requireAuth";
import { createHeatmapPublicAclHandler } from "../../services/heatmapImageAcl";

// Narrow surface of ObjectStorageService that the object-serving handler needs,
// so the EXACT mounted handler can be exercised against a fake in tests without
// hitting Replit Object Storage (Task #2493).
export interface ObjectServeService {
  getObjectEntityFile(objectPath: string): Promise<any>;
  canAccessObjectEntity(args: {
    userId?: string;
    objectFile: any;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean>;
  downloadObject(objectFile: any, res: Response): Promise<void>;
}

/**
 * Build the `GET /objects/:objectPath(*)` handler.
 *
 * Security model (Track A — A-001, Task #1571): a MISSING ACL policy means
 * PRIVATE. Only an explicit `visibility: "public"` policy is served to anyone;
 * everything else requires an authenticated session that passes
 * canAccessObjectEntity. This default is deliberately NOT relaxed by Task #2493
 * — heatmap objects are made viewable by setting an explicit public policy on
 * them, not by changing this rule.
 */
export function createServeObjectHandler(deps: {
  service: ObjectServeService;
  getAclPolicy: (objectFile: any) => Promise<ObjectAclPolicy | null>;
}) {
  return async (req: Request & { user?: any }, res: Response) => {
    try {
      const objectFile = await deps.service.getObjectEntityFile(req.path);
      const aclPolicy = await deps.getAclPolicy(objectFile);
      const isPublic = aclPolicy?.visibility === "public";

      if (!isPublic) {
        const userId: string | undefined = req.user?.claims?.sub;
        if (!userId) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        const allowed = await deps.service.canAccessObjectEntity({
          userId,
          objectFile,
          requestedPermission: ObjectPermission.READ,
        });
        if (!allowed) {
          return res.status(403).json({ error: "Forbidden" });
        }
      }

      await deps.service.downloadObject(objectFile, res);
    } catch (error) {
      console.error("Error serving object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      return res.status(500).json({ error: "Failed to serve object" });
    }
  };
}

/**
 * Register object storage routes for file uploads.
 *
 * This provides example routes for the presigned URL upload flow:
 * 1. POST /api/uploads/request-url - Get a presigned URL for uploading
 * 2. The client then uploads directly to the presigned URL
 *
 * IMPORTANT: These are example routes. Customize based on your use case:
 * - Add authentication middleware for protected uploads
 * - Add file metadata storage (save to database after upload)
 * - Add ACL policies for access control
 */
export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  /**
   * Request a presigned URL for file upload.
   *
   * Request body (JSON):
   * {
   *   "name": "filename.jpg",
   *   "size": 12345,
   *   "contentType": "image/jpeg"
   * }
   *
   * Response:
   * {
   *   "uploadURL": "https://storage.googleapis.com/...",
   *   "objectPath": "/objects/uploads/uuid"
   * }
   *
   * IMPORTANT: The client should NOT send the file to this endpoint.
   * Send JSON metadata only, then upload the file directly to uploadURL.
   */
  app.post("/api/uploads/request-url", isAuthenticated, async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({
          error: "Missing required field: name",
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();

      // Extract object path from the presigned URL for later reference
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadURL,
        objectPath,
        // Echo back the metadata for client convenience
        metadata: { name, size, contentType },
      });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  /**
   * Alternative presigned URL endpoint for Uppy uploads.
   * Used by the CEO Pulse and other image upload components.
   */
  app.post("/api/object-storage/presigned-url", isAuthenticated, async (req, res) => {
    try {
      const { fileName, contentType, directory } = req.body;

      if (!fileName) {
        return res.status(400).json({
          error: "Missing required field: fileName",
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadUrl: uploadURL,
        url: uploadURL,
        method: "PUT",
        fields: {},
        headers: {
          "Content-Type": contentType || "application/octet-stream",
        },
        objectPath,
        publicUrl: objectPath,
      });
    } catch (error) {
      console.error("Error generating presigned URL:", error);
      res.status(500).json({ error: "Failed to generate presigned URL" });
    }
  });

  /**
   * Task #2493 — mark a just-uploaded heatmap (Map Rank) screenshot public.
   *
   * Objects created via the presigned-URL flow carry no ACL metadata, so the
   * serving route below treats them as private and a public-report `<img>`
   * 401/403s. The operator's client calls this right after upload to set an
   * EXPLICIT `{ owner, visibility: "public" }` policy on that one object. Guarded
   * so a user can only (re)claim an unclaimed object or one they already own.
   */
  app.post(
    "/api/object-storage/heatmap-public",
    isAuthenticated,
    createHeatmapPublicAclHandler({ storage: objectStorageService }),
  );

  /**
   * Serve uploaded objects.
   *
   * GET /objects/:objectPath(*)
   *
   * Security model (Track A — A-001):
   * - Read the object's ACL policy from custom metadata.
   * - If the policy is missing → PRIVATE (Task #1571). Only an explicit
   *   `visibility: "public"` policy is served to anyone.
   * - Otherwise require an authenticated session AND that the user pass
   *   canAccessObjectEntity. Path-obscurity (UUID keys) is no longer the
   *   only line of defense.
   */
  app.get(
    "/objects/:objectPath(*)",
    createServeObjectHandler({
      service: objectStorageService,
      getAclPolicy: getObjectAclPolicy,
    }),
  );
}

