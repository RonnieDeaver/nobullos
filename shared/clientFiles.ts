/**
 * Task #4023 — shared policy + pure helpers for in-app client file storage.
 *
 * Everything here is pure and environment-free so BOTH sides use one source
 * of truth:
 *   - server: claim gating, safe-mime resolution, serving disposition;
 *   - client: kind icons/filters, inline-preview capability, size cap
 *     pre-checks before minting an upload URL.
 *
 * SECURITY MODEL (mirrors shared/attachments.ts for feedback):
 *   - Objects are minted under `client-files/<clientId>/<uuid>[.ext]` inside
 *     PRIVATE_OBJECT_DIR. The claim gate verifies the object path sits inside
 *     the EXACT client namespace being claimed into — a caller can never
 *     attach an object minted for another client (or another flow's
 *     namespace) to this client's file space.
 *   - The client-declared content type is NEVER trusted. The serving mime is
 *     resolved server-side from magic-byte sniffing at claim time
 *     (server/replit_integrations/object_storage/generalUploadSniff.ts);
 *     unknown formats are stored as application/octet-stream.
 *   - Inline rendering is restricted to INLINE_PREVIEW_MIMES; everything else
 *     is served with `Content-Disposition: attachment` + nosniff. text/html,
 *     image/svg+xml and XML types are deliberately NOT inline-previewable —
 *     HTML/SVG sniff to text/plain (source view) or download.
 */

// ── Storage namespace ──────────────────────────────────────────────────────

/** Root prefix under PRIVATE_OBJECT_DIR for all client files. */
export const CLIENT_FILES_ROOT_PREFIX = "client-files";

/**
 * Client ids are uuid-shaped varchars (gen_random_uuid). Constrain hard so a
 * hostile "clientId" can never inject path separators / dots into a storage
 * key. Lowercase hex + hyphens only, sane length.
 */
const CLIENT_ID_KEY_RE = /^[a-f0-9-]{8,64}$/;

export function isStorageSafeClientId(clientId: string): boolean {
  return typeof clientId === "string" && CLIENT_ID_KEY_RE.test(clientId);
}

/** PRIVATE_OBJECT_DIR-relative key prefix for one client's file space. */
export function clientFilesKeyPrefix(clientId: string): string {
  if (!isStorageSafeClientId(clientId)) {
    throw new Error(`clientFilesKeyPrefix: unsafe client id`);
  }
  return `${CLIENT_FILES_ROOT_PREFIX}/${clientId}/`;
}

/** `/objects/...` path prefix for one client's file space. */
export function clientFilesObjectPathPrefix(clientId: string): string {
  return `/objects/${clientFilesKeyPrefix(clientId)}`;
}

/**
 * Convert a claimed `/objects/client-files/<clientId>/<uuid>[.ext]` path to
 * the PRIVATE_OBJECT_DIR-relative storage key, verifying namespace confinement
 * along the way. Returns null when the path is outside the client's space or
 * shaped suspiciously (extra segments, traversal, empty leaf).
 */
export function clientFileKeyFromObjectPath(
  objectPath: string,
  clientId: string,
): string | null {
  if (!isStorageSafeClientId(clientId)) return null;
  const prefix = clientFilesObjectPathPrefix(clientId);
  if (typeof objectPath !== "string" || !objectPath.startsWith(prefix)) return null;
  const leaf = objectPath.slice(prefix.length);
  // Exactly one leaf segment: `<uuid>` or `<uuid>.<ext>` — no nesting, no
  // traversal, no query/fragment smuggling.
  if (!/^[a-f0-9-]{16,64}(\.[a-z0-9]{1,5})?$/.test(leaf)) return null;
  return `${CLIENT_FILES_ROOT_PREFIX}/${clientId}/${leaf}`;
}

/**
 * Pure claim gate (mirrors feedbackAttachmentClaimAllowed): the object must
 * live inside the claiming client's namespace, and must be either unclaimed
 * (no ACL owner yet) or already owned by the claiming user (double-submit of
 * the same claim). Any other owner means another actor got there first.
 */
export function clientFileClaimAllowed(args: {
  objectPath: string;
  clientId: string;
  currentOwner: string | null | undefined;
  claimantUserId: string;
}):
  | { allowed: true; objectKey: string }
  | { allowed: false; reason: "path_outside_namespace" | "owned_by_other" } {
  const objectKey = clientFileKeyFromObjectPath(args.objectPath, args.clientId);
  if (!objectKey) return { allowed: false, reason: "path_outside_namespace" };
  if (args.currentOwner && args.currentOwner !== args.claimantUserId) {
    return { allowed: false, reason: "owned_by_other" };
  }
  return { allowed: true, objectKey };
}

// ── Size cap ───────────────────────────────────────────────────────────────

/** Per-file cap. Generous (call recordings / videos), still bounded. */
export const CLIENT_FILE_MAX_BYTES = 500 * 1024 * 1024; // 500 MiB

/** Total-uncompressed cap for a bulk zip download request. */
export const CLIENT_FILE_ZIP_MAX_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GiB

// ── External share links (Task #4028) ─────────────────────────────────────

/** Random token size for external share links (base64url in the URL). */
export const CLIENT_FILE_SHARE_TOKEN_BYTES = 32;

/** Expiry policy: default and hard cap, in days. */
export const CLIENT_FILE_SHARE_DEFAULT_DAYS = 7;
export const CLIENT_FILE_SHARE_MAX_DAYS = 90;

/** Choices offered by the UI — all ≤ the cap. */
export const CLIENT_FILE_SHARE_EXPIRY_CHOICES_DAYS: readonly number[] = [1, 7, 30, 90];

/**
 * 32 random bytes base64url-encode to 43 chars; accept a small range so the
 * shape check survives an encoding tweak without admitting junk.
 */
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;

export function isShareTokenShaped(token: unknown): boolean {
  return typeof token === "string" && SHARE_TOKEN_RE.test(token);
}

/** App-relative public path a minted token is served from. */
export function shareLinkPath(token: string): string {
  return `/share/file/${token}`;
}

export type ClientFileShareStatus = "active" | "expired" | "revoked";

/** Pure link-state decision shared by server gate and client badges. */
export function shareLinkStatus(
  link: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date = new Date(),
): ClientFileShareStatus {
  if (link.revokedAt) return "revoked";
  const exp = new Date(link.expiresAt);
  if (!Number.isFinite(exp.getTime()) || exp.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

// ── Kind classification (icons, filters, preview capability) ──────────────

export type ClientFileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "doc"
  | "sheet"
  | "slides"
  | "archive"
  | "other";

/** Canonical kind list for filters/validation — keep in lockstep with the
 * ClientFileKind union above. */
export const CLIENT_FILE_KINDS: readonly ClientFileKind[] = [
  "image",
  "video",
  "audio",
  "pdf",
  "text",
  "doc",
  "sheet",
  "slides",
  "archive",
  "other",
];

export const CLIENT_FILE_KIND_LABELS: Record<ClientFileKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  text: "Text",
  doc: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  archive: "Archive",
  other: "File",
};

/** Mimes the download route may serve inline (previews). Everything else is
 * attachment-only. Keep this an EXACT-match whitelist — never patterns. */
export const INLINE_PREVIEW_MIMES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "application/pdf",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
  "audio/flac",
  "audio/mp4",
  "audio/aac",
  // Plain-text family: served inline AS text/plain with nosniff — browsers
  // display source, never execute. text/html & image/svg+xml are NOT here
  // and must never be (stored uploads sniff to text/plain instead).
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
]);

export function isInlinePreviewableMime(mime: string | null | undefined): boolean {
  return !!mime && INLINE_PREVIEW_MIMES.has(mime);
}

/**
 * The Content-Type the download route actually sends. The text family is
 * flattened to text/plain for inline views so no browser ever interprets a
 * text-ish payload as something richer; all other whitelisted mimes serve
 * as themselves. (Downloads always send the stored mime.)
 */
export function inlineServingMime(mime: string): string {
  if (mime === "text/csv" || mime === "text/markdown" || mime === "application/json") {
    return "text/plain";
  }
  return mime;
}

export function classifyClientFileKind(
  mime: string | null | undefined,
  name?: string | null,
): ClientFileKind {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/") || m === "application/json") return "text";
  if (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    m === "application/vnd.ms-excel"
  ) {
    return "sheet";
  }
  if (
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    m === "application/msword" ||
    m === "application/rtf"
  ) {
    return "doc";
  }
  if (
    m === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    m === "application/vnd.ms-powerpoint"
  ) {
    return "slides";
  }
  if (
    m === "application/zip" ||
    m === "application/gzip" ||
    m === "application/vnd.rar" ||
    m === "application/x-7z-compressed"
  ) {
    return "archive";
  }
  // Octet-stream fallback: let a well-known extension inform the ICON only
  // (serving stays attachment-only regardless).
  const ext = fileNameExtension(name || "");
  if (ext && EXTENSION_KIND_HINTS[ext]) return EXTENSION_KIND_HINTS[ext];
  return "other";
}

const EXTENSION_KIND_HINTS: Record<string, ClientFileKind> = {
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  ppt: "slides",
  pptx: "slides",
  zip: "archive",
  gz: "archive",
  rar: "archive",
  "7z": "archive",
  txt: "text",
  md: "text",
  json: "text",
};

/**
 * Extension-based refinements applied ONLY on top of a matching container
 * sniff (server-side). E.g. bytes say "zip" — the extension picks the OOXML
 * flavor; bytes say "text" — the extension picks the text/* flavor. The
 * extension can never escalate an unknown/binary blob into a previewable
 * mime because refinement is keyed by the sniffed base family.
 */
export const ZIP_CONTAINER_EXTENSION_MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const OLE_CONTAINER_EXTENSION_MIMES: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};

export const TEXT_EXTENSION_MIMES: Record<string, string> = {
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
};

export function fileNameExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "";
  const ext = name.slice(idx + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

// ── Names ──────────────────────────────────────────────────────────────────

export const CLIENT_FILE_NAME_MAX_CHARS = 255;

/**
 * Normalize a user-supplied file/folder name for storage & display: strip
 * control chars and path separators, collapse runs of whitespace, trim, cap
 * length. Returns null when nothing displayable survives (caller 400s or
 * substitutes a fallback).
 */
export function sanitizeClientFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_FILE_NAME_MAX_CHARS)
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned;
}

/** Split "report.final.pdf" → { base: "report.final", ext: ".pdf" }. */
export function splitClientFileName(name: string): { base: string; ext: string } {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return { base: name, ext: "" };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

/**
 * Produce "name (2).pdf"-style candidates for restore/move collisions.
 * `n` starts at 2.
 */
export function numberedFileName(name: string, n: number): string {
  const { base, ext } = splitClientFileName(name);
  const suffix = ` (${n})`;
  const maxBase = CLIENT_FILE_NAME_MAX_CHARS - ext.length - suffix.length;
  return `${base.slice(0, Math.max(1, maxBase))}${suffix}${ext}`;
}

// ── Formatting (client display; kept here so admin usage view matches) ────

export function formatByteSize(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}
