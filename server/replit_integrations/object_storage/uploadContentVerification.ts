/**
 * Task #3964 (audit A-006) — server-side content verification for
 * direct-to-storage presigned uploads.
 *
 * WHY THIS EXISTS — mint-time constraints are NOT available. Presigned PUT
 * URLs are minted through the Replit sidecar signing endpoint (`signObjectURL`
 * in ./objectStorage.ts). Its request protocol carries ONLY
 * `{ bucket_name, object_name, method, expires_at }`, and the URLs it returns
 * are signed with `X-Goog-SignedHeaders=host` (probed 2026-08-07: extra
 * `content_type` / `headers` / `conditions` request fields are ignored and
 * the signed-header set does not change). Replit's App Storage documentation
 * likewise exposes no size/content-type signing parameters. So GCS V4
 * `Content-Length-Range` / signed-`Content-Type` style enforcement CANNOT be
 * attached at mint time — an uploader can PUT any bytes with any declared
 * MIME type until the signed URL expires.
 *
 * Enforcement therefore happens HERE, server-side, after upload and before
 * any flow accepts (attaches / claims / persists a reference to) the object:
 *
 *   - size comes from object metadata (GCS computes it from the stored
 *     bytes; an uploader cannot forge it);
 *   - kind (image / video) comes from magic-byte sniffing of the object's
 *     first bytes — the stored `contentType` metadata is uploader-controlled
 *     (the PUT request sets it) and is deliberately ignored;
 *   - each accepting flow declares which kinds it allows and their byte caps.
 *
 * Pure decision logic lives in `evaluateUploadContent`; IO is confined behind
 * the tiny `UploadObjectReader` interface so tests exercise everything with
 * fakes (no storage, no DB). `ObjectStorageService.verifyObjectEntityContent`
 * (./objectStorage.ts) adapts a real GCS `File` to this interface.
 */

export type UploadKind = "image" | "video";

export interface SniffedUploadFormat {
  kind: UploadKind;
  /** Short label for logs, e.g. "png", "mp4-family". */
  format: string;
  /**
   * Canonical MIME type derived from the sniffed bytes. Trustworthy — unlike
   * the uploader-supplied object metadata — so accept paths may stamp it back
   * onto the object to launder a lying `contentType` (e.g. an image that was
   * PUT with `text/html` must never later be served as HTML).
   */
  mime: string;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function hexAt(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (bytes[offset + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * ISO-BMFF (`ftyp`) major brands that are still-image HEIF/AVIF containers.
 * Every other `ftyp` brand (isom/iso2/mp41/mp42/avc1/dash/`qt  `/3gp…) is
 * treated as an MP4-family video.
 */
const HEIF_IMAGE_BRANDS = new Set([
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "avif",
  "avis",
]);

/**
 * Legacy QuickTime files may start with a non-`ftyp` top-level atom. These
 * atom names at offset 4 identify an ISO-BMFF/QuickTime container even
 * without a brand declaration.
 */
const QUICKTIME_LEGACY_ATOMS = new Set(["moov", "mdat", "free", "skip", "wide", "pnot"]);

/**
 * Identify an upload's real format from its leading bytes. Returns null when
 * the bytes match no supported image/video container — callers treat that as
 * a rejection, never as "assume it's fine".
 */
export function sniffUploadFormat(bytes: Uint8Array): SniffedUploadFormat | null {
  if (bytes.length < 4) return null;

  // ── Images ────────────────────────────────────────────────────────────────
  if (hexAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", format: "png", mime: "image/png" };
  }
  if (hexAt(bytes, 0, [0xff, 0xd8, 0xff])) {
    return { kind: "image", format: "jpeg", mime: "image/jpeg" };
  }
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) {
    return { kind: "image", format: "gif", mime: "image/gif" };
  }
  if (asciiAt(bytes, 0, "RIFF")) {
    if (asciiAt(bytes, 8, "WEBP")) {
      return { kind: "image", format: "webp", mime: "image/webp" };
    }
    if (asciiAt(bytes, 8, "AVI ")) {
      return { kind: "video", format: "avi", mime: "video/x-msvideo" };
    }
    return null;
  }
  if (asciiAt(bytes, 0, "BM")) {
    return { kind: "image", format: "bmp", mime: "image/bmp" };
  }
  if (hexAt(bytes, 0, [0x49, 0x49, 0x2a, 0x00]) || hexAt(bytes, 0, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { kind: "image", format: "tiff", mime: "image/tiff" };
  }

  // ── Videos ────────────────────────────────────────────────────────────────
  if (asciiAt(bytes, 0, "OggS")) {
    // Ogg is audio-or-video; the feedback flow maps `video/ogg` → `.ogv`, so
    // classify the container as video (audio-only Ogg still lands here).
    return { kind: "video", format: "ogg", mime: "video/ogg" };
  }
  if (hexAt(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML — WebM or Matroska. The DocType string sits at a variable offset;
    // scan the head we already have.
    const scanLimit = Math.min(bytes.length, 128);
    let isMatroska = false;
    for (let i = 0; i < scanLimit - 8; i++) {
      if (asciiAt(bytes, i, "matroska")) {
        isMatroska = true;
        break;
      }
    }
    return isMatroska
      ? { kind: "video", format: "mkv", mime: "video/x-matroska" }
      : { kind: "video", format: "webm", mime: "video/webm" };
  }
  if (asciiAt(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
    if (HEIF_IMAGE_BRANDS.has(brand.trim())) {
      const isAvif = brand.startsWith("avi");
      return {
        kind: "image",
        format: isAvif ? "avif" : "heif",
        mime: isAvif ? "image/avif" : "image/heic",
      };
    }
    if (brand.startsWith("qt")) {
      return { kind: "video", format: "quicktime", mime: "video/quicktime" };
    }
    return { kind: "video", format: "mp4-family", mime: "video/mp4" };
  }
  for (const atom of QUICKTIME_LEGACY_ATOMS) {
    if (asciiAt(bytes, 4, atom)) {
      return { kind: "video", format: "quicktime-legacy", mime: "video/quicktime" };
    }
  }

  return null;
}

/** Per-flow policy: which content kinds are accepted, and their byte caps. */
export interface UploadContentConstraints {
  kinds: Partial<Record<UploadKind, { maxBytes: number }>>;
}

export type UploadContentRejectionReason =
  | "empty_object"
  | "unrecognized_content"
  | "disallowed_type"
  | "too_large";

export type UploadContentVerdict =
  | { ok: true; sizeBytes: number; sniffed: SniffedUploadFormat }
  | {
      ok: false;
      reason: UploadContentRejectionReason;
      /** Log-safe explanation (sizes/kinds only — never object contents). */
      detail: string;
      sizeBytes: number;
      sniffed: SniffedUploadFormat | null;
    };

/** Pure accept/reject decision over already-fetched size + head bytes. */
export function evaluateUploadContent(args: {
  sizeBytes: number;
  headBytes: Uint8Array;
  constraints: UploadContentConstraints;
}): UploadContentVerdict {
  const { sizeBytes, headBytes, constraints } = args;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return {
      ok: false,
      reason: "empty_object",
      detail: `object has no stored bytes (size=${String(sizeBytes)})`,
      sizeBytes,
      sniffed: null,
    };
  }
  const sniffed = sniffUploadFormat(headBytes);
  if (!sniffed) {
    return {
      ok: false,
      reason: "unrecognized_content",
      detail: "leading bytes match no supported image/video format",
      sizeBytes,
      sniffed: null,
    };
  }
  const cap = constraints.kinds[sniffed.kind];
  if (!cap) {
    const allowed = Object.keys(constraints.kinds).join(", ") || "none";
    return {
      ok: false,
      reason: "disallowed_type",
      detail: `sniffed ${sniffed.kind} (${sniffed.format}) but this flow accepts: ${allowed}`,
      sizeBytes,
      sniffed,
    };
  }
  if (sizeBytes > cap.maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      detail: `${sizeBytes} bytes exceeds the ${sniffed.kind} cap of ${cap.maxBytes} bytes`,
      sizeBytes,
      sniffed,
    };
  }
  return { ok: true, sizeBytes, sniffed };
}

/** How many leading bytes the sniffer reads. 4 KB covers every magic number above. */
export const UPLOAD_SNIFF_HEAD_BYTES = 4096;

/**
 * Minimal read surface over a stored object. The real adapter (in
 * ./objectStorage.ts) backs this with audited metadata + a ranged read
 * stream; tests back it with in-memory fakes.
 */
export interface UploadObjectReader {
  /** Storage-computed object size in bytes (metadata — not caller-supplied). */
  getSizeBytes(): Promise<number>;
  /** First `maxBytes` bytes of the object (fewer if the object is smaller). */
  readHead(maxBytes: number): Promise<Uint8Array>;
}

/**
 * Fetch size + head bytes through `reader` and evaluate `constraints`.
 * Empty objects are rejected without a read (a ranged GET on a zero-byte
 * object can fail with 416, and there is nothing to sniff anyway).
 */
export async function verifyUploadObjectContent(
  reader: UploadObjectReader,
  constraints: UploadContentConstraints,
): Promise<UploadContentVerdict> {
  const sizeBytes = await reader.getSizeBytes();
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return evaluateUploadContent({ sizeBytes, headBytes: new Uint8Array(0), constraints });
  }
  const headBytes = await reader.readHead(Math.min(UPLOAD_SNIFF_HEAD_BYTES, sizeBytes));
  return evaluateUploadContent({ sizeBytes, headBytes, constraints });
}

/**
 * Ownership gate for deleting a rejected upload: deletion is allowed only
 * while the object is still unclaimed (no ACL owner) or still owned by the
 * exact actor the accepting flow verified at its claim gate. Pure so the
 * decision table is unit-testable; ObjectStorageService re-reads the ACL
 * immediately before deleting and pairs this check with a metageneration
 * precondition, so a claim landing between check and delete aborts the
 * delete (412) instead of destroying a now-owned object.
 */
export function rejectedUploadDeleteAllowed(
  currentOwner: string | null | undefined,
  expectedOwner: string | null,
): boolean {
  if (!currentOwner) return true; // still unclaimed
  return expectedOwner !== null && currentOwner === expectedOwner;
}

/**
 * The slice of ObjectStorageService that accepting flows (feedback claim,
 * ATS video submit, heatmap public claim) need for post-upload verification —
 * kept narrow so route/service tests can inject fakes.
 */
export interface UploadContentVerifyingStorage {
  verifyObjectEntityContent(
    objectPath: string,
    constraints: UploadContentConstraints,
  ): Promise<UploadContentVerdict>;
  /**
   * Best-effort, RACE-SAFE removal of an upload that failed verification.
   * `expectedOwner` states the caller's entitlement: `null` = "delete only
   * while still unclaimed" (ATS portal, heatmap claim), a user id = "delete
   * only while still unclaimed or still owned by that user" (feedback claim).
   * Implementations must re-check ownership at delete time and skip
   * (returning false) when a concurrent actor claimed the object after the
   * caller's gate.
   */
  deleteRejectedUploadObject(
    objectPath: string,
    opts: { expectedOwner: string | null },
  ): Promise<boolean>;
}
