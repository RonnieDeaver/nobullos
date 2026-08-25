/**
 * Task #4544 — map-ranking scan upload contract, shared by server and client.
 *
 * Background: the marketing slide's "Map Rankings" scan slots and the 56px GBP
 * thumbnails render whatever object a location's `heatmapImageUrl` points at.
 * A real client's stored upload was a 2254×2271 portrait HEADSHOT (JPEG), which
 * rendered as a "Local map visibility scan" and was also served full-size for
 * 56px thumbnails.
 *
 * Contract (single source — server claim gate and client render guard must not
 * drift):
 *   - A map scan is a SCREENSHOT: the claim endpoint accepts only formats
 *     screenshot pipelines produce (PNG/WebP — the editor's uploader literally
 *     says "Upload PNG"). Camera photos (JPEG/HEIC) are rejected at claim time.
 *   - The client render guard checks the served Content-Type (the claim flow
 *     stamps the sniffed MIME onto the object since Task #3964; browser-set
 *     types cover older uploads) and shows an explicit "scan pending" state
 *     for anything else — a portrait never renders as a scan.
 *   - A resized thumbnail variant lives at a deterministic sibling key
 *     (`<key>__thumb`) so 56px thumbnails never pull multi-MP originals; the
 *     client falls back to the original if the variant does not exist yet
 *     (legacy objects are healed lazily on authenticated report read).
 */

/** Sniffed formats (uploadContentVerification `format` labels) accepted as scans. */
export const HEATMAP_SCAN_IMAGE_FORMATS: ReadonlySet<string> = new Set([
  "png",
  "webp",
]);

/** Served Content-Type values the client treats as a valid scan image. */
export const HEATMAP_SCAN_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/webp",
]);

/**
 * Pure classifier over a client HEAD-probe outcome: only a 2xx response whose
 * Content-Type is a scan MIME counts as a renderable scan.
 */
export function classifyScanProbe(args: {
  ok: boolean;
  contentType: string | null;
}): "valid" | "invalid" {
  if (!args.ok) return "invalid";
  const mime = (args.contentType ?? "").split(";")[0].trim().toLowerCase();
  return HEATMAP_SCAN_IMAGE_MIMES.has(mime) ? "valid" : "invalid";
}

/**
 * Only same-origin claimed uploads are renderable scan candidates: they are
 * the sole URL shape the claim endpoint mints and the only one whose served
 * Content-Type our own route controls. External hosts / data: URIs have no
 * enforceable MIME contract and fail closed.
 */
export function isProbeableScanUrl(url: string): boolean {
  return url.startsWith("/objects/");
}

/** Suffix of the derived thumbnail-variant object key/path. */
export const HEATMAP_THUMB_SUFFIX = "__thumb";

/** Width (px) of the generated thumbnail variant — 56px display at 3× DPR. */
export const HEATMAP_THUMB_WIDTH = 168;

/**
 * Deterministic thumbnail-variant path for a stored heatmap object path
 * (`/objects/uploads/<uuid>` → `/objects/uploads/<uuid>__thumb`). Returns null
 * for non-object paths (external URLs) and for paths that already ARE a
 * variant.
 */
export function heatmapThumbPath(objectPath: string): string | null {
  if (!objectPath.startsWith("/objects/")) return null;
  if (objectPath.endsWith(HEATMAP_THUMB_SUFFIX)) return null;
  return `${objectPath}${HEATMAP_THUMB_SUFFIX}`;
}
