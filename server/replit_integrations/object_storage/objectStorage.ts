import { Storage, File } from "@google-cloud/storage";
import { Response } from "express";
import { randomUUID } from "crypto";
import {
  ObjectAclPolicy,
  ObjectPermission,
  canAccessObject,
  getObjectAclPolicy,
  parseObjectAclPolicyFromMetadata,
  setObjectAclPolicy,
} from "./objectAcl";
import {
  auditedCreateReadStream,
  auditedCreateWriteStream,
  auditedDelete,
  auditedExists,
  auditedGetFiles,
  auditedGetMetadata,
  auditedSetMetadata,
  auditedSignObjectURL,
} from "./audit";
import {
  UPLOAD_SNIFF_HEAD_BYTES,
  rejectedUploadDeleteAllowed,
  verifyUploadObjectContent,
  type UploadContentConstraints,
  type UploadContentVerdict,
  type UploadObjectReader,
} from "./uploadContentVerification";
import {
  verifyGeneralUploadObjectContent,
  type GeneralUploadVerdict,
} from "./generalUploadSniff";
import { clientFilesKeyPrefix } from "@shared/clientFiles";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

// Task #2657 — every backup artifact (DB dumps, file manifests, and the
// incrementally-archived file bytes) lives under this single prefix inside
// PRIVATE_OBJECT_DIR. The file-backup enumeration MUST skip this prefix so a
// backup never tries to back itself up (unbounded growth / self-reference).
export const BACKUP_KEY_PREFIX = "backups/";

// A single enumerated source object the file-backup producer may archive.
export interface BackupSourceObject {
  // `/<bucket>/<object>` — globally unique identity, used to key the archive.
  fullPath: string;
  bucketName: string;
  objectName: string;
  sizeBytes: number | null;
  contentType: string | null;
  // GCS generation + md5 let a later run tell "same bytes" from "changed".
  generation: string | null;
  md5Hash: string | null;
  updated: string | null;
}

// Task #3520 — a single object listed under a PRIVATE_OBJECT_DIR prefix.
export interface PrivatePrefixObject {
  /** Key relative to PRIVATE_OBJECT_DIR (e.g. `comms-draft-attachments/x.png`). */
  objectKey: string;
  sizeBytes: number | null;
  timeCreated: Date | null;
  /**
   * Task #3983 — the ACL owner parsed from the listing's custom metadata
   * (`custom:aclPolicy`), or null when the object carries no readable ACL
   * policy. The abandoned-upload sweep uses this to skip claimed objects
   * without a per-object metadata GET; the value comes from the same list
   * response as size/timeCreated. Optional so injected test fixtures for
   * older sweeps stay valid.
   */
  aclOwner?: string | null;
}

// The object storage client is used to interact with the object storage service.
export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

// The object storage service is used to interact with the object storage service.
export class ObjectStorageService {
  constructor() {}

  // Gets the public object search paths.
  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  // Gets the private object directory.
  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  // Search for a public object from the search paths.
  async searchPublicObject(filePath: string): Promise<File | null> {
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${filePath}`;

      // Full path format: /<bucket_name>/<object_name>
      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      // Check if file exists
      const [exists] = await auditedExists(file);
      if (exists) {
        return file;
      }
    }

    return null;
  }

  // Downloads an object to the response.
  async downloadObject(file: File, res: Response, cacheTtlSec: number = 3600) {
    try {
      // Get file metadata
      const [metadata] = await auditedGetMetadata(file);
      // Get the ACL policy for the object.
      const aclPolicy = await getObjectAclPolicy(file);
      const isPublic = aclPolicy?.visibility === "public";
      // Set appropriate headers
      res.set({
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Content-Length": metadata.size,
        "Cache-Control": `${
          isPublic ? "public" : "private"
        }, max-age=${cacheTtlSec}`,
      });

      // Stream the file to the response
      const stream = auditedCreateReadStream(file);

      stream.on("error", (err) => {
        console.error("Stream error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: "Error streaming file" });
        }
      });

      stream.pipe(res);
    } catch (error) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error downloading file" });
      }
    }
  }

  // Streams an arbitrary readable into a fixed key under the private
  // object dir. Used by background workers (e.g. Twilio recording
  // archiver) that need a deterministic path so subsequent retries are
  // idempotent. The body must be a Node Readable (from `fetch().body`,
  // wrap a Web ReadableStream with `Readable.fromWeb()` first).
  async streamUploadToPrivateKey(
    objectKey: string,
    body: NodeJS.ReadableStream,
    contentType: string,
  ): Promise<{ objectKey: string; size: number | null }> {
    if (!objectKey || objectKey.startsWith("/") || objectKey.includes("..")) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    let dir = this.getPrivateObjectDir();
    if (dir.endsWith("/")) dir = dir.slice(0, -1);
    const fullPath = `${dir}/${objectKey}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const writeStream = auditedCreateWriteStream(file, {
      metadata: { contentType },
      resumable: false,
    });
    await new Promise<void>((resolve, reject) => {
      body.on("error", reject);
      writeStream.on("error", reject);
      writeStream.on("finish", () => resolve());
      body.pipe(writeStream);
    });
    let size: number | null = null;
    try {
      const [meta] = await auditedGetMetadata(file);
      const raw = meta.size;
      size = typeof raw === "string" ? parseInt(raw, 10) : (raw as number) ?? null;
    } catch {
      // metadata read isn't critical
    }
    return { objectKey, size };
  }

  // Downloads an object already written under PRIVATE_OBJECT_DIR into an
  // in-memory Buffer. Intended for small objects (e.g. re-processing an
  // uploaded attachment); throws ObjectNotFoundError if the key is absent.
  async downloadPrivateKeyToBuffer(objectKey: string): Promise<Buffer> {
    const file = await this.getPrivateObjectFileByKey(objectKey);
    const chunks: Buffer[] = [];
    const stream = auditedCreateReadStream(file);
    return new Promise<Buffer>((resolve, reject) => {
      stream.on("data", (chunk: Buffer | string) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
      );
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  // Returns the @google-cloud/storage File handle for a key already
  // written under PRIVATE_OBJECT_DIR. Throws ObjectNotFoundError if the
  // file does not exist. Use file.createReadStream() to stream out, or
  // file.download({ destination }) to materialise to disk.
  async getPrivateObjectFileByKey(objectKey: string): Promise<File> {
    if (!objectKey || objectKey.startsWith("/") || objectKey.includes("..")) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    let dir = this.getPrivateObjectDir();
    if (dir.endsWith("/")) dir = dir.slice(0, -1);
    const fullPath = `${dir}/${objectKey}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await auditedExists(file);
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  // Task #4023 — open an audited read stream for a private object by key.
  // Callers own the response headers: client-file downloads set DB-derived
  // mime + Content-Disposition rather than echoing object metadata (which
  // downloadObject does), so serving decisions never trust uploader-supplied
  // contentType. Throws ObjectNotFoundError when the object is absent.
  async createPrivateObjectReadStream(
    objectKey: string,
  ): Promise<NodeJS.ReadableStream> {
    const file = await this.getPrivateObjectFileByKey(objectKey);
    return auditedCreateReadStream(file);
  }

  // Task #3520 — enumerate objects under a single prefix inside
  // PRIVATE_OBJECT_DIR (e.g. `comms-draft-attachments/`). Metadata
  // (size, timeCreated) is read from the listing, not per-object GETs, so
  // this is one paged `list` call. Used by the draft-attachment cleanup
  // sweep to find orphaned draft originals + thumbnails.
  async listPrivateObjectsByPrefix(
    prefix: string,
  ): Promise<PrivatePrefixObject[]> {
    if (!prefix || prefix.startsWith("/") || prefix.includes("..")) {
      throw new Error(`Invalid object prefix: ${prefix}`);
    }
    let dir = this.getPrivateObjectDir();
    if (dir.endsWith("/")) dir = dir.slice(0, -1);
    const { bucketName, objectName: baseName } = parseObjectPath(dir);
    const bucket = objectStorageClient.bucket(bucketName);
    const listPrefix = `${baseName ? `${baseName}/` : ""}${prefix}`;
    const [files] = await auditedGetFiles(bucket as any, {
      prefix: listPrefix,
      autoPaginate: true,
    });
    const out: PrivatePrefixObject[] = [];
    for (const file of files) {
      const objectName: string = (file as any).name;
      // Skip "directory placeholder" objects (end in `/`, no bytes).
      if (!objectName || objectName.endsWith("/")) continue;
      // Convert back to the PRIVATE_OBJECT_DIR-relative object key.
      const relKey = baseName
        ? objectName.slice(baseName.length + 1)
        : objectName;
      const meta: any = (file as any).metadata || {};
      const rawSize = meta.size;
      const sizeBytes =
        typeof rawSize === "string"
          ? parseInt(rawSize, 10)
          : typeof rawSize === "number"
            ? rawSize
            : null;
      // Task #3983 — surface the ACL owner from the listing metadata so a
      // sweep can skip claimed objects without a per-object GET. A malformed
      // policy parses to null (treated as unclaimed here); the race-safe
      // delete path re-reads the ACL before any destructive action anyway.
      let aclOwner: string | null = null;
      try {
        aclOwner = parseObjectAclPolicyFromMetadata(meta)?.owner ?? null;
      } catch {
        aclOwner = null;
      }
      out.push({
        objectKey: relKey,
        sizeBytes: Number.isFinite(sizeBytes as number)
          ? (sizeBytes as number)
          : null,
        timeCreated: meta.timeCreated ? new Date(meta.timeCreated) : null,
        aclOwner,
      });
    }
    return out;
  }

  // Task #3520 — best-effort delete of an object under PRIVATE_OBJECT_DIR.
  // A missing object is treated as already-deleted (returns false); any
  // other storage error propagates so callers can count real failures.
  async deletePrivateObjectByKey(objectKey: string): Promise<boolean> {
    if (!objectKey || objectKey.startsWith("/") || objectKey.includes("..")) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    let dir = this.getPrivateObjectDir();
    if (dir.endsWith("/")) dir = dir.slice(0, -1);
    const fullPath = `${dir}/${objectKey}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    try {
      await auditedDelete(file);
      return true;
    } catch (err: any) {
      if (err?.code === 404) return false;
      throw err;
    }
  }

  // Task #2657 — enumerate every backup-eligible object: the private object
  // dir contents plus every public search path. The backup prefix is skipped
  // (see BACKUP_KEY_PREFIX) so backups never recurse into themselves. Returns
  // a de-duplicated list keyed by full `/bucket/object` path; metadata
  // (size, contentType, md5, generation) is read from the listing, not via a
  // per-object GET, so this is a small number of `list` calls.
  async listBackupSourceObjects(): Promise<BackupSourceObject[]> {
    const searchRoots = new Set<string>();
    let privateDir = this.getPrivateObjectDir();
    if (privateDir.endsWith("/")) privateDir = privateDir.slice(0, -1);
    searchRoots.add(privateDir);
    for (const p of this.getPublicObjectSearchPaths()) {
      searchRoots.add(p.endsWith("/") ? p.slice(0, -1) : p);
    }

    // The fully-qualified prefix that holds backup artifacts. Any enumerated
    // object whose full path starts with it is skipped.
    const backupFullPrefix = `${privateDir}/${BACKUP_KEY_PREFIX}`;

    const byFullPath = new Map<string, BackupSourceObject>();
    for (const root of searchRoots) {
      const { bucketName, objectName: prefix } = parseObjectPath(root);
      const bucket = objectStorageClient.bucket(bucketName);
      const listPrefix = prefix ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "";
      const [files] = await auditedGetFiles(bucket as any, {
        prefix: listPrefix,
        autoPaginate: true,
      });
      for (const file of files) {
        const objectName: string = (file as any).name;
        // A "directory placeholder" object ends in `/` with no bytes.
        if (!objectName || objectName.endsWith("/")) continue;
        const fullPath = `/${bucketName}/${objectName}`;
        if (fullPath.startsWith(backupFullPrefix)) continue;
        if (byFullPath.has(fullPath)) continue;
        const meta: any = (file as any).metadata || {};
        const rawSize = meta.size;
        const sizeBytes =
          typeof rawSize === "string"
            ? parseInt(rawSize, 10)
            : typeof rawSize === "number"
              ? rawSize
              : null;
        byFullPath.set(fullPath, {
          fullPath,
          bucketName,
          objectName,
          sizeBytes: Number.isFinite(sizeBytes as number) ? (sizeBytes as number) : null,
          contentType: meta.contentType ?? null,
          generation: meta.generation != null ? String(meta.generation) : null,
          md5Hash: meta.md5Hash ?? null,
          updated: meta.updated ?? null,
        });
      }
    }
    return Array.from(byFullPath.values());
  }

  // Task #2657 — copy a source object's bytes into the backup archive under
  // PRIVATE_OBJECT_DIR if (and only if) the archive copy is absent. The
  // archive key is generation-stamped by the caller, so an unchanged file
  // (same generation) is never re-copied across daily runs — this is what
  // makes "keep everything" affordable. Returns whether a copy happened.
  async copyObjectToBackupArchive(
    source: BackupSourceObject,
    archiveObjectKey: string,
  ): Promise<{ copied: boolean }> {
    if (
      !archiveObjectKey ||
      archiveObjectKey.startsWith("/") ||
      archiveObjectKey.includes("..") ||
      !archiveObjectKey.startsWith(BACKUP_KEY_PREFIX)
    ) {
      throw new Error(`Invalid backup archive key: ${archiveObjectKey}`);
    }
    let dir = this.getPrivateObjectDir();
    if (dir.endsWith("/")) dir = dir.slice(0, -1);
    const destFullPath = `${dir}/${archiveObjectKey}`;
    const { bucketName: destBucket, objectName: destObject } =
      parseObjectPath(destFullPath);
    const destFile = objectStorageClient.bucket(destBucket).file(destObject);
    const [destExists] = await auditedExists(destFile);
    if (destExists) return { copied: false };
    const srcFile = objectStorageClient
      .bucket(source.bucketName)
      .file(source.objectName);
    await srcFile.copy(destFile);
    return { copied: true };
  }

  // Gets the upload URL for an object entity.
  //
  // `opts.extension` (optional) stamps a file extension onto the generated
  // key (e.g. `uploads/<uuid>.mp4`) so the stored path is self-describing —
  // callers that mix images and videos (feedback attachments) can tell them
  // apart by path without re-reading object metadata. The extension is
  // sanitized to a short alphanumeric token; anything else is ignored and the
  // key stays extensionless (the prior behavior, unchanged for other callers).
  //
  // SECURITY (Task #3964 / audit A-006): the signed PUT URL this returns is
  // UNCONSTRAINED. The sidecar signing protocol (`signObjectURL` below) sends
  // only { bucket_name, object_name, method, expires_at } and returns URLs
  // signed with `X-Goog-SignedHeaders=host` (probed 2026-08-07: extra
  // content_type/headers/conditions fields are ignored), and Replit's App
  // Storage docs expose no constraint parameters — so Content-Length /
  // Content-Type CANNOT be bound into the signature at mint time. Any flow
  // that later ACCEPTS the uploaded object must therefore run
  // `verifyObjectEntityContent()` before attaching/claiming it (the feedback
  // claim, ATS submit-video, and heatmap public-claim flows all do).
  async getObjectEntityUploadURL(opts?: { extension?: string; prefix?: string }): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    const ext = sanitizeObjectKeyExtension(opts?.extension);
    // `prefix` lets a caller mint into a dedicated sub-namespace (e.g.
    // `feedback-uploads`) so a downstream ACL-bypassing reader can scope itself
    // to objects only its own upload flow produces. Defaults to `uploads` so
    // existing callers are unchanged.
    const prefix = sanitizeObjectKeyPrefix(opts?.prefix);
    const fullPath = `${privateObjectDir}/${prefix}/${objectId}${ext ? `.${ext}` : ""}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    // Sign URL for PUT method with TTL
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  // Task #4023 — mint a presigned PUT URL inside ONE client's file-storage
  // namespace: `client-files/<clientId>/<uuid>[.ext]`. A dedicated minter
  // (rather than getObjectEntityUploadURL's `prefix` option) because that
  // option only allows a single sanitized path segment, while the per-client
  // namespace needs two — and the claim gate
  // (shared/clientFiles.ts clientFileClaimAllowed) requires the EXACT
  // per-client prefix so cross-client attachment is structurally impossible.
  // Same security posture as getObjectEntityUploadURL: the signed URL is
  // UNCONSTRAINED, so the claim flow must run verifyClientFileObjectContent
  // before persisting any reference.
  async getClientFileUploadURL(
    clientId: string,
    opts?: { extension?: string },
  ): Promise<{ uploadUrl: string; objectPath: string }> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    // Throws on a non-uuid-shaped id — never mints outside the namespace.
    const keyPrefix = clientFilesKeyPrefix(clientId);
    const objectId = randomUUID();
    const ext = sanitizeObjectKeyExtension(opts?.extension);
    const objectKey = `${keyPrefix}${objectId}${ext ? `.${ext}` : ""}`;
    const dir = privateObjectDir.endsWith("/")
      ? privateObjectDir.slice(0, -1)
      : privateObjectDir;
    const fullPath = `${dir}/${objectKey}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadUrl = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
    return { uploadUrl, objectPath: `/objects/${objectKey}` };
  }

  // Task #4023 — post-upload verification for GENERAL file uploads (client
  // file storage): storage-computed size against a byte cap + magic-byte
  // sniff to derive the SAFE serving mime. Unknown formats are accepted as
  // application/octet-stream (download-only serving), unlike the image/video
  // flows — see ./generalUploadSniff.ts for the policy split.
  //
  // On an `ok` verdict the object's `contentType` metadata is rewritten to
  // the derived mime whenever the stored value differs — the metadata comes
  // from the uploader's PUT headers and the generic /objects serving route
  // echoes it, so e.g. an executable uploaded as `text/html` must be
  // laundered before anything can serve it. A failed rewrite throws rather
  // than accepting silently (fail closed).
  async verifyClientFileObjectContent(
    objectPath: string,
    opts: { maxBytes: number; fileName?: string },
  ): Promise<GeneralUploadVerdict> {
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await auditedGetMetadata(file);
    const rawSize = metadata?.size;
    const sizeBytes =
      typeof rawSize === "string" ? parseInt(rawSize, 10) : Number(rawSize ?? 0);
    const reader: UploadObjectReader = {
      getSizeBytes: () => Promise.resolve(sizeBytes),
      async readHead(maxBytes: number) {
        const stream = auditedCreateReadStream(file, {
          start: 0,
          end: Math.max(0, maxBytes - 1),
        });
        const chunks: Buffer[] = [];
        return await new Promise<Uint8Array>((resolve, reject) => {
          stream.on("data", (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          stream.on("error", reject);
          stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        });
      },
    };
    const verdict = await verifyGeneralUploadObjectContent(reader, opts);
    if (verdict.ok && metadata?.contentType !== verdict.mime) {
      await auditedSetMetadata(file, { contentType: verdict.mime });
    }
    return verdict;
  }

  // Task #3964 (audit A-006) — post-upload verification of a client-uploaded
  // object: storage-computed size + magic-byte sniff of the leading bytes,
  // checked against the accepting flow's per-kind constraints (see
  // ./uploadContentVerification.ts for why this cannot happen at mint time).
  //
  // On an `ok` verdict the object's `contentType` metadata is additionally
  // rewritten to the sniffed canonical MIME type when the stored value lies —
  // the metadata comes from the uploader's PUT headers, and the serving route
  // echoes it, so e.g. a PNG uploaded as `text/html` must be laundered before
  // any flow (heatmap public claim) makes it servable. A failed rewrite on a
  // lying object throws rather than accepting silently (fail closed).
  //
  // Throws ObjectNotFoundError when the path does not resolve to a stored
  // object.
  async verifyObjectEntityContent(
    objectPath: string,
    constraints: UploadContentConstraints,
  ): Promise<UploadContentVerdict> {
    const file = await this.getObjectEntityFile(objectPath);
    const [metadata] = await auditedGetMetadata(file);
    const rawSize = metadata?.size;
    const sizeBytes =
      typeof rawSize === "string" ? parseInt(rawSize, 10) : Number(rawSize ?? 0);
    const reader: UploadObjectReader = {
      // Size comes from the metadata fetch above (one storage round trip);
      // resolve it directly instead of an awaitless async method.
      getSizeBytes: () => Promise.resolve(sizeBytes),
      async readHead(maxBytes: number) {
        const stream = auditedCreateReadStream(file, {
          start: 0,
          end: Math.max(0, maxBytes - 1),
        });
        const chunks: Buffer[] = [];
        return await new Promise<Uint8Array>((resolve, reject) => {
          stream.on("data", (chunk: Buffer | string) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          stream.on("error", reject);
          stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
        });
      },
    };
    const verdict = await verifyUploadObjectContent(reader, constraints);
    if (verdict.ok && metadata?.contentType !== verdict.sniffed.mime) {
      await auditedSetMetadata(file, { contentType: verdict.sniffed.mime });
    }
    return verdict;
  }

  // Task #3964 — RACE-SAFE best-effort removal of an upload that failed
  // verifyObjectEntityContent. The caller's claim gate proves entitlement
  // BEFORE verification, but a different actor may claim the object between
  // that gate and this delete (TOCTOU). So the delete re-reads the ACL and
  // only proceeds while rejectedUploadDeleteAllowed(currentOwner,
  // expectedOwner) holds, and the DELETE itself carries an
  // ifMetagenerationMatch precondition pinned to that same metadata snapshot:
  // an ACL claim bumps the object's metageneration, so a concurrent claim
  // makes GCS refuse the delete (412) instead of destroying a now-owned
  // object. Returns true when the object is gone (deleted or already
  // absent), false when skipped or failed.
  async deleteRejectedUploadObject(
    objectPath: string,
    opts: { expectedOwner: string | null },
  ): Promise<boolean> {
    try {
      const file = await this.getObjectEntityFile(objectPath);
      const [metadata] = await auditedGetMetadata(file);
      const currentOwner =
        parseObjectAclPolicyFromMetadata(metadata as never)?.owner ?? null;
      if (!rejectedUploadDeleteAllowed(currentOwner, opts.expectedOwner)) {
        console.warn(
          `[ObjectStorage] Skipped deleting rejected upload ${objectPath}: claimed by another actor`,
        );
        return false;
      }
      await auditedDelete(file, {
        ignoreNotFound: true,
        ifMetagenerationMatch: metadata.metageneration,
      });
      return true;
    } catch (err: any) {
      if (err instanceof ObjectNotFoundError) return true;
      if (err?.code === 412) {
        console.warn(
          `[ObjectStorage] Skipped deleting rejected upload ${objectPath}: concurrently claimed (metageneration changed)`,
        );
        return false;
      }
      console.warn(
        `[ObjectStorage] Failed to delete rejected upload ${objectPath}: ${err?.message ?? err}`,
      );
      return false;
    }
  }

  // ── Task #4544 — thin /objects/-path byte adapters (HeatmapVariantStorage) ──
  // Wrap the existing private-key primitives so callers that hold an
  // `/objects/<key>` path (e.g. heatmap thumb-variant generation) can read,
  // probe, and write derived objects without duplicating path parsing.

  /** True when the /objects/ path exists (metadata-only probe). */
  async objectExists(objectPath: string): Promise<boolean> {
    try {
      await this.getObjectEntityFile(objectPath);
      return true;
    } catch (err) {
      if (err instanceof ObjectNotFoundError) return false;
      throw err;
    }
  }

  /** Full bytes of an /objects/ path (small objects only — buffered in memory). */
  async downloadObjectBytes(objectPath: string): Promise<Buffer> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    return this.downloadPrivateKeyToBuffer(objectPath.slice("/objects/".length));
  }

  /** Upload bytes to an /objects/ path (idempotent overwrite of that key). */
  async uploadObjectBytes(
    objectPath: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void> {
    if (!objectPath.startsWith("/objects/")) {
      throw new Error(`uploadObjectBytes requires an /objects/ path: ${objectPath}`);
    }
    const { Readable } = await import("node:stream");
    await this.streamUploadToPrivateKey(
      objectPath.slice("/objects/".length),
      Readable.from(bytes),
      contentType,
    );
  }

  // Gets the object entity file from the object path.
  async getObjectEntityFile(objectPath: string): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await auditedExists(objectFile);
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  normalizeObjectEntityPath(
    rawPath: string,
  ): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }
  
    // Extract the path from the URL by removing query parameters and domain
    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;
  
    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }
  
    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }
  
    // Extract the entity ID from the path
    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }

  // Reads the ACL policy for an object entity referenced by its `/objects/...`
  // path. Returns null when the object carries no ACL metadata. Throws
  // ObjectNotFoundError if the object does not exist. Used to verify provenance
  // (e.g. that a feedback attachment is owned by the user who submitted it)
  // before serving it through an ACL-bypassing reader.
  async getObjectEntityAclPolicy(
    objectPath: string,
  ): Promise<ObjectAclPolicy | null> {
    const objectFile = await this.getObjectEntityFile(objectPath);
    return getObjectAclPolicy(objectFile);
  }

  // Tries to set the ACL policy for the object entity and return the normalized path.
  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) {
      return normalizedPath;
    }

    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  // Checks if the user can access the object entity.
  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: File;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}

// Normalize a caller-supplied file extension to a short, safe token suitable
// for appending to an object key. Returns "" for anything that isn't a plain
// alphanumeric extension of a sane length, so a hostile or malformed value can
// never inject path separators / dots into the key.
function sanitizeObjectKeyExtension(extension?: string): string {
  if (!extension || typeof extension !== "string") return "";
  const trimmed = extension.trim().replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(trimmed)) return "";
  return trimmed;
}

// Normalize a caller-supplied upload sub-namespace to a single safe path
// segment (lowercase alphanumerics + hyphens). Anything else falls back to the
// default `uploads`, so a hostile/malformed value can never inject path
// separators, `..`, or extra segments into the key.
function sanitizeObjectKeyPrefix(prefix?: string): string {
  if (!prefix || typeof prefix !== "string") return "uploads";
  const trimmed = prefix.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(trimmed)) return "uploads";
  return trimmed;
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  return auditedSignObjectURL({
    endpoint: "/object-storage/signed-object-url",
    bucketName,
    objectName,
    method,
    ttlSec,
    fetcher: async () => {
      const request = {
        bucket_name: bucketName,
        object_name: objectName,
        method,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      };
      const response = await fetch(
        `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        }
      );
      if (!response.ok) {
        throw new Error(
          `Failed to sign object URL, errorcode: ${response.status}, ` +
            `make sure you're running on Replit`
        );
      }

      const { signed_url: signedURL } = await response.json();
      return {
        status: response.status,
        signedUrl: signedURL,
        bodyBytes: typeof signedURL === "string" ? Buffer.byteLength(signedURL) : 0,
      };
    },
  });
}

