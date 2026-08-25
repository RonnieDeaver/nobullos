/**
 * Supporting images for update briefs — The NoBull Brief (Task #4293).
 *
 * Company-update editions carry uploaded images (e.g. a book cover) instead
 * of — or alongside — AI-generated chart PNGs. This module owns everything
 * about those images EXCEPT the DB metadata writes (reportStorage.ts) and
 * the HTTP endpoints (routes/reports.ts):
 *
 *   • object-storage key/URL construction (slot-addressed, extension comes
 *     ONLY from stored metadata — public URLs carry no extension),
 *   • the object-storage operations behind upload/delete/serving,
 *   • {{image-N}} placeholder resolution for the full letter.
 *
 * Storage layout mirrors the chart-image family (chartImageGenerator.ts):
 * bytes live in the PUBLIC bucket under ceo-pulse/<monthKey>/image-<slot>.<ext>
 * beside chart-<i>.png, written via auditedSave and served through the same
 * /api/ceo-pulse-charts/:monthKey/ route family with the same published-pulse
 * gate. `slot` is the stable per-brief identity ({{image-<slot>}} in letters),
 * so reordering or deleting other images never retargets a letter reference.
 */
import type { Response } from "express";
import {
  ObjectStorageService,
  objectStorageClient,
} from "../replit_integrations/object_storage/objectStorage";
import { auditedDelete, auditedSave } from "../replit_integrations/object_storage/audit";
import { getPublicBucketPath } from "./chartImageGenerator";
import type { CeoPulseImageExt, CeoPulseSupportingImage } from "@shared/schema";

const CONTENT_TYPE_BY_EXT: Record<CeoPulseImageExt, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Bucket-relative public search path for an image object. */
export function ceoPulseImageSearchPath(monthKey: string, slot: number, ext: CeoPulseImageExt): string {
  return `ceo-pulse/${monthKey}/image-${slot}.${ext}`;
}

/**
 * Public serving URL for a supporting image. Extension-less by design: the
 * route resolves the real object key from stored metadata, never from the
 * request (pre-approved public-surface posture for this route family).
 */
export function getCeoPulseImageUrl(monthKey: string, slot: number): string {
  return `/api/ceo-pulse-charts/${monthKey}/image-${slot}`;
}

/**
 * Object-storage operations behind the supporting-image endpoints, exposed
 * as a MUTABLE singleton so DB-bound route tests can monkey-patch methods
 * with an in-memory fake (established vendor-seam pattern — no ESM resolve
 * hooks). Production behavior mirrors the chart-image family: audited
 * writes/deletes under the public ceo-pulse/<monthKey>/ prefix, serving via
 * searchPublicObject + downloadObject with a 1h cache TTL.
 */
export const ceoPulseImageObjects = {
  /** Write image bytes (overwrites the slot key — idempotent on retry). */
  async save(monthKey: string, slot: number, ext: CeoPulseImageExt, bytes: Buffer): Promise<void> {
    const { bucketName, basePath } = getPublicBucketPath();
    const file = objectStorageClient
      .bucket(bucketName)
      .file(`${basePath}/${ceoPulseImageSearchPath(monthKey, slot, ext)}`);
    await auditedSave(file, bytes, {
      contentType: CONTENT_TYPE_BY_EXT[ext],
      metadata: {
        cacheControl: "public, max-age=3600",
      },
    });
  },

  /**
   * Best-effort object removal. `ignoreNotFound`: metadata is removed first
   * (public stops referencing the slot immediately), so a retried delete or
   * an upload-compensation call may find the object already gone.
   */
  async delete(monthKey: string, slot: number, ext: CeoPulseImageExt): Promise<void> {
    const { bucketName, basePath } = getPublicBucketPath();
    const file = objectStorageClient
      .bucket(bucketName)
      .file(`${basePath}/${ceoPulseImageSearchPath(monthKey, slot, ext)}`);
    await auditedDelete(file, { ignoreNotFound: true });
  },

  /**
   * Stream the object to the response. Returns false when the object does
   * not exist (caller sends its 404); true when a response has been started
   * (including downloadObject's own error handling).
   */
  async serve(
    monthKey: string,
    slot: number,
    ext: CeoPulseImageExt,
    res: Response,
  ): Promise<boolean> {
    const objService = new ObjectStorageService();
    const file = await objService.searchPublicObject(ceoPulseImageSearchPath(monthKey, slot, ext));
    if (!file) return false;
    await objService.downloadObject(file, res, 3600);
    return true;
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Resolve {{image-N}} placeholders in letter HTML against the brief's stored
 * image metadata (N = slot). Unlike chart placeholders there is no
 * "not yet generated" box variant: metadata is authoritative for uploads, so
 * a slot absent from `images` (deleted image, typo, unpublished draft being
 * embedded) ALWAYS strips cleanly — a letter never renders a broken tag.
 * Captions are HTML-escaped; the letter itself is trusted CEO-authored HTML.
 */
export function resolveImagePlaceholders(
  html: string,
  monthKey: string,
  images: CeoPulseSupportingImage[],
): string {
  if (!html.includes("{{image-")) return html;
  const bySlot = new Map(images.map((img) => [img.slot, img]));
  return html.replace(/\{\{image-(\d+)\}\}/g, (_match, slotStr) => {
    const slot = parseInt(slotStr, 10);
    const img = bySlot.get(slot);
    if (!img) return "";
    const caption = typeof img.caption === "string" ? img.caption.trim() : "";
    const figcaption = caption
      ? `<figcaption style="margin-top:8px;font-size:13px;color:#8a7e6e;text-align:center;">${escapeHtml(caption)}</figcaption>`
      : "";
    const alt = escapeHtml(caption || `Supporting image ${slot}`);
    return `<figure style="margin:16px 0;"><img src="${getCeoPulseImageUrl(monthKey, slot)}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;display:block;margin:0 auto;" />${figcaption}</figure>`;
  });
}
