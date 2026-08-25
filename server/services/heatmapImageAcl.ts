/**
 * Task #2493 — make manually-uploaded heatmap (Map Rank) screenshots viewable.
 *
 * Objects uploaded through `POST /api/object-storage/presigned-url` carry NO ACL
 * metadata. The object-serving route (`GET /objects/:objectPath(*)`) correctly
 * treats a missing ACL policy as PRIVATE (Task #1571 security default), so a
 * heatmap `<img>` in a public report — viewed by an unauthenticated client —
 * 401/403s and never renders.
 *
 * The fix is NOT to relax the global missing-ACL-is-private default. Instead we
 * set an EXPLICIT `{ owner, visibility: "public" }` policy on the specific
 * objects that are referenced as a location's `heatmapImageUrl`:
 *   1. right after the operator uploads one (the authenticated claim endpoint
 *      built by `createHeatmapPublicAclHandler`), and
 *   2. lazily on report read for already-uploaded objects that predate this fix
 *      (`ensureHeatmapImagesPublic`), so an operator never has to re-upload.
 *
 * Both paths are scoped to objects that are EITHER unclaimed OR already owned by
 * the acting user (mirrors the feedback-attachment claim guard), so a user can
 * never flip someone else's private object to public.
 */
import type { Request, Response } from "express";
import type { ObjectAclPolicy } from "../replit_integrations/object_storage/objectAcl";
import { ObjectNotFoundError } from "../replit_integrations/object_storage/objectStorage";
import type {
  UploadContentConstraints,
  UploadContentVerifyingStorage,
} from "../replit_integrations/object_storage/uploadContentVerification";
import {
  HEATMAP_SCAN_IMAGE_FORMATS,
  HEATMAP_THUMB_WIDTH,
  heatmapThumbPath,
} from "../../shared/heatmapScan";

// Minimal slice of ObjectStorageService this module needs — kept narrow so the
// route/heal logic can be exercised against a fake in tests without touching
// Replit Object Storage.
export interface HeatmapAclStorage {
  getObjectEntityAclPolicy(objectPath: string): Promise<ObjectAclPolicy | null>;
  trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string>;
}

/**
 * Decide whether `userId` is allowed to (re)claim `objectPath` as a public
 * heatmap object given its current ACL owner. Unclaimed objects and objects the
 * user already owns are claimable; an object owned by someone else is not.
 */
export function heatmapPublicClaimAllowed(
  existingOwner: string | null | undefined,
  userId: string,
): boolean {
  if (!existingOwner) return true;
  return existingOwner === userId;
}

// Task #3964 (audit A-006) — heatmap claims accept images only. The client
// uploader (ReportForm) caps files at 5MB; the server cap is double that so a
// legitimate edge upload never bounces, while a video or multi-hundred-MB
// blob can no longer be flipped into publicly-served content.
export const HEATMAP_IMAGE_UPLOAD_CONSTRAINTS: UploadContentConstraints = {
  kinds: { image: { maxBytes: 10 * 1024 * 1024 } },
};

/**
 * Set `{ owner, visibility: "public" }` on a single heatmap object, but only if
 * the claim guard allows it. Returns true when the object now carries a public
 * policy (either just set, or already public+claimable). Best-effort: returns
 * false on any storage error so callers can keep going.
 */
export async function setHeatmapObjectPublic(
  storage: HeatmapAclStorage,
  objectPath: string,
  ownerUserId: string,
): Promise<boolean> {
  if (!objectPath || !objectPath.startsWith("/objects/")) return false;
  try {
    const existing = await storage.getObjectEntityAclPolicy(objectPath);
    if (existing?.visibility === "public") {
      // Already public — only re-confirm the claim is legitimate; nothing to do.
      return heatmapPublicClaimAllowed(existing.owner, ownerUserId);
    }
    if (!heatmapPublicClaimAllowed(existing?.owner, ownerUserId)) {
      return false;
    }
    await storage.trySetObjectEntityAclPolicy(objectPath, {
      owner: ownerUserId,
      visibility: "public",
    });
    return true;
  } catch {
    return false;
  }
}

// Pull every `heatmapImageUrl` object path referenced anywhere in a report's
// sections (operator editor shape AND public sanitized shape both expose the
// marketing locations as `gbpLocations` and/or `gbp.locations`).
export function collectHeatmapObjectPaths(sections: any[]): string[] {
  const paths = new Set<string>();
  const visitLocations = (locs: any) => {
    if (!Array.isArray(locs)) return;
    for (const loc of locs) {
      const url = loc?.heatmapImageUrl;
      if (typeof url === "string" && url.startsWith("/objects/")) {
        paths.add(url);
      }
    }
  };
  for (const section of sections ?? []) {
    if (section?.sectionKey !== "marketing") continue;
    const data = section?.data ?? {};
    visitLocations(data.gbpLocations);
    visitLocations(data.gbp?.locations);
  }
  return Array.from(paths);
}

/**
 * Lazily heal already-uploaded heatmap objects so their `<img>` renders. Scoped
 * strictly to objects that are ALREADY referenced as a location heatmap (never a
 * blanket missing-ACL → public flip). Best-effort and idempotent: objects that
 * are already public are skipped after a single metadata read.
 */
export async function ensureHeatmapImagesPublic(
  storage: HeatmapAclStorage,
  sections: any[],
  ownerUserId: string,
): Promise<number> {
  const paths = collectHeatmapObjectPaths(sections);
  if (paths.length === 0) return 0;
  let healed = 0;
  for (const path of paths) {
    const ok = await setHeatmapObjectPublic(storage, path, ownerUserId);
    if (ok) healed += 1;
  }
  return healed;
}

// ─── Task #4544 — thumbnail variants ─────────────────────────────────────────

/**
 * Narrow byte-level surface needed to build a resized thumbnail variant next
 * to a claimed scan object. Kept separate from HeatmapAclStorage so the heal
 * paths that only touch ACLs keep their tiny interface (and existing test
 * fakes keep compiling).
 */
export interface HeatmapVariantStorage extends HeatmapAclStorage {
  /** Full bytes of an /objects/ path. Throws ObjectNotFoundError when absent. */
  downloadObjectBytes(objectPath: string): Promise<Buffer>;
  /** True when the /objects/ path exists (metadata-only check). */
  objectExists(objectPath: string): Promise<boolean>;
  /** Upload bytes to an /objects/ path (private namespace key). */
  uploadObjectBytes(
    objectPath: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<void>;
}

/**
 * Best-effort: generate the deterministic `__thumb` webp variant for a claimed
 * scan object and mark it public under the same owner. Idempotent — an
 * existing variant is left alone (concurrent double-generation just rewrites
 * the same derived key with the same content; no DB row is involved). Returns
 * true when the variant exists and is public afterwards. Never throws.
 */
export async function ensureHeatmapThumbVariant(
  storage: HeatmapVariantStorage,
  objectPath: string,
  ownerUserId: string,
): Promise<boolean> {
  const thumbPath = heatmapThumbPath(objectPath);
  if (!thumbPath) return false;
  try {
    if (!(await storage.objectExists(thumbPath))) {
      const original = await storage.downloadObjectBytes(objectPath);
      const { default: sharp } = await import("sharp");
      const thumb = await sharp(original, { animated: false })
        .rotate()
        .resize({ width: HEATMAP_THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
      await storage.uploadObjectBytes(thumbPath, thumb, "image/webp");
    }
    return await setHeatmapObjectPublic(storage, thumbPath, ownerUserId);
  } catch (err) {
    console.warn(
      `[heatmapImageAcl] thumb variant generation skipped for ${objectPath}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Lazy heal companion to `ensureHeatmapImagesPublic`: make sure every valid
 * referenced scan has its `__thumb` variant so 56px thumbnails stop serving
 * multi-MP originals. Only objects that sniff as scan formats (PNG/WebP) get a
 * variant — a legacy portrait photo gets none (the client render guard hides
 * it entirely). Best-effort; after the variant exists each pass costs one
 * metadata read per referenced object.
 */
export async function ensureHeatmapThumbVariants(
  storage: HeatmapVariantStorage & UploadContentVerifyingStorage,
  sections: any[],
  ownerUserId: string,
): Promise<number> {
  let ensured = 0;
  for (const path of collectHeatmapObjectPaths(sections)) {
    const thumbPath = heatmapThumbPath(path);
    if (!thumbPath) continue;
    try {
      if (await storage.objectExists(thumbPath)) {
        ensured += 1;
        continue;
      }
      const verdict = await storage.verifyObjectEntityContent(
        path,
        HEATMAP_IMAGE_UPLOAD_CONSTRAINTS,
      );
      if (!verdict.ok || !HEATMAP_SCAN_IMAGE_FORMATS.has(verdict.sniffed.format)) {
        continue; // not a scan — never mint a variant for it
      }
      if (await ensureHeatmapThumbVariant(storage, path, ownerUserId)) {
        ensured += 1;
      }
    } catch {
      // best-effort — a storage hiccup on one object never blocks the rest
    }
  }
  return ensured;
}

/**
 * Authenticated endpoint factory: the operator's client calls this right after a
 * heatmap screenshot finishes uploading to mark that specific object public, so
 * it renders immediately in the editor and the public report.
 */
export function createHeatmapPublicAclHandler(deps: {
  // The claim endpoint needs post-upload content verification on top of the
  // ACL surface (Task #3964); the heal paths above keep the narrow interface.
  // Task #4544 optionally adds the byte-level variant surface — when present,
  // a successful claim also mints the `__thumb` variant (best-effort).
  storage: HeatmapAclStorage &
    UploadContentVerifyingStorage &
    Partial<Omit<HeatmapVariantStorage, keyof HeatmapAclStorage>>;
}) {
  return async (req: Request & { user?: any }, res: Response) => {
    try {
      const userId: string | undefined = req.user?.claims?.sub;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const objectPath = (req.body?.objectPath ?? "").toString();
      if (!objectPath || !objectPath.startsWith("/objects/")) {
        return res
          .status(400)
          .json({ error: "objectPath must be an /objects/ path" });
      }

      const existing = await deps.storage.getObjectEntityAclPolicy(objectPath);
      if (!heatmapPublicClaimAllowed(existing?.owner, userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      // Task #3964 (audit A-006) — this endpoint makes the object PUBLICLY
      // served and its presigned PUT was unconstrained, so verify the stored
      // bytes first: they must sniff as a real image within the cap. Runs
      // after the claim guard so a foreign-owned object can be neither probed
      // nor deleted. Rejected objects are deleted only when unclaimed — an
      // object this user already owns may be referenced by an existing
      // report, so it is left in place (just never made public).
      const verdict = await deps.storage.verifyObjectEntityContent(
        objectPath,
        HEATMAP_IMAGE_UPLOAD_CONSTRAINTS,
      );
      // Task #4544 — scan slots must never render camera photos. A map scan
      // is a screenshot; only screenshot formats (PNG/WebP) are claimable.
      // Same reject handling as a failed verdict below.
      const notAScan =
        verdict.ok && !HEATMAP_SCAN_IMAGE_FORMATS.has(verdict.sniffed.format);
      if (!verdict.ok || notAScan) {
        if (!existing?.owner) {
          // expectedOwner: null = delete only while STILL unclaimed; a claim
          // racing in after the gate above aborts the delete at the storage
          // layer instead of destroying a now-owned object.
          await deps.storage.deleteRejectedUploadObject(objectPath, {
            expectedOwner: null,
          });
        }
        return notAScan
          ? res.status(400).json({
              error:
                "Map scans must be PNG/WebP screenshots — this file looks like a photo, not a map-ranking scan",
              reason: "not_a_map_scan",
            })
          : res.status(400).json({
              error: "Uploaded file is not a servable image",
              reason: verdict.ok ? undefined : verdict.reason,
            });
      }

      await deps.storage.trySetObjectEntityAclPolicy(objectPath, {
        owner: userId,
        visibility: "public",
      });

      // Task #4544 — mint the 56px-thumbnail variant right away (best-effort;
      // legacy objects are healed lazily on report read instead).
      if (
        typeof deps.storage.downloadObjectBytes === "function" &&
        typeof deps.storage.objectExists === "function" &&
        typeof deps.storage.uploadObjectBytes === "function"
      ) {
        await ensureHeatmapThumbVariant(
          deps.storage as HeatmapVariantStorage,
          objectPath,
          userId,
        );
      }
      return res.json({ objectPath, visibility: "public" });
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      console.error("Error setting heatmap object public:", error);
      return res.status(500).json({ error: "Failed to set heatmap ACL" });
    }
  };
}
