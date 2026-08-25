/**
 * Task #4023 — content sniffing for GENERAL file uploads (client file
 * storage), extending the image/video-only sniffer in
 * ./uploadContentVerification.ts.
 *
 * Same threat model as that module (read its header): presigned PUT URLs are
 * unconstrained, the uploader-declared contentType is hostile input, so any
 * accepting flow must derive the serving mime from the stored BYTES before
 * persisting a reference. The difference here is the accept policy:
 *
 *   - The feedback/ATS flows accept only image/video and REJECT everything
 *     else (`sniffUploadFormat` → null ⇒ rejection).
 *   - Client file storage is a general Drive-style space: unknown formats
 *     are ACCEPTED but stored as `application/octet-stream` and served
 *     download-only (`Content-Disposition: attachment` + nosniff). Only
 *     mimes on the shared INLINE_PREVIEW_MIMES whitelist may ever render
 *     inline, and nothing here can emit text/html or image/svg+xml — HTML
 *     and SVG bytes classify as plain text (source view) by design.
 *
 * Rejections remain: empty objects and objects over the caller's byte cap.
 *
 * Pure logic only — IO stays behind the UploadObjectReader seam so unit
 * tests cover every branch with in-memory bytes.
 */
import {
  sniffUploadFormat,
  UPLOAD_SNIFF_HEAD_BYTES,
  type UploadObjectReader,
} from "./uploadContentVerification";
import {
  OLE_CONTAINER_EXTENSION_MIMES,
  TEXT_EXTENSION_MIMES,
  ZIP_CONTAINER_EXTENSION_MIMES,
  fileNameExtension,
} from "@shared/clientFiles";

export interface GeneralSniffedFormat {
  /** Canonical serving mime derived from the bytes (+ ext refinement). */
  mime: string;
  /** Short label for logs, e.g. "pdf", "zip", "utf8-text". */
  format: string;
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
 * Heuristic: does the head look like human-readable text? NUL bytes or a
 * meaningful share of non-printable control bytes ⇒ binary. (UTF-8
 * multi-byte sequences pass because their bytes are all >= 0x80.)
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) return false;
    // Allow tab (9), LF (10), CR (13), and everything >= 0x20.
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) suspicious++;
  }
  return suspicious / bytes.length < 0.02;
}

/**
 * Identify a general upload's format from its leading bytes (+ the original
 * file name for CONTAINER refinement only — a zip named report.xlsx is
 * OOXML-flavored, but no extension can ever escalate unknown bytes into a
 * previewable mime). Returns null for unrecognized binary content — callers
 * treat that as application/octet-stream, NOT as a rejection.
 */
export function sniffGeneralUploadFormat(
  bytes: Uint8Array,
  fileName?: string,
): GeneralSniffedFormat | null {
  if (bytes.length < 4) {
    // Tiny files can still be legitimate text ("ok\n").
    return looksLikeText(bytes)
      ? { mime: refineTextMime(fileName), format: "short-text" }
      : null;
  }

  // Image/video containers — delegate to the existing sniffer.
  const av = sniffUploadFormat(bytes);
  if (av) return { mime: av.mime, format: av.format };

  // PDF
  if (asciiAt(bytes, 0, "%PDF-")) {
    return { mime: "application/pdf", format: "pdf" };
  }

  // Audio
  if (asciiAt(bytes, 0, "ID3")) {
    return { mime: "audio/mpeg", format: "mp3-id3" };
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) {
    // MPEG audio frame sync (11 set bits + a valid layer). Checked AFTER all
    // container formats above so their headers can't be shadowed.
    return { mime: "audio/mpeg", format: "mpeg-audio-frame" };
  }
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) {
    return { mime: "audio/wav", format: "wav" };
  }
  if (asciiAt(bytes, 0, "fLaC")) {
    return { mime: "audio/flac", format: "flac" };
  }

  // Archives / OOXML containers
  if (hexAt(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) || hexAt(bytes, 0, [0x50, 0x4b, 0x05, 0x06])) {
    const ext = fileNameExtension(fileName || "");
    const refined = ZIP_CONTAINER_EXTENSION_MIMES[ext];
    return refined
      ? { mime: refined, format: `ooxml-${ext}` }
      : { mime: "application/zip", format: "zip" };
  }
  if (hexAt(bytes, 0, [0x1f, 0x8b])) {
    return { mime: "application/gzip", format: "gzip" };
  }
  if (asciiAt(bytes, 0, "Rar!")) {
    return { mime: "application/vnd.rar", format: "rar" };
  }
  if (hexAt(bytes, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    return { mime: "application/x-7z-compressed", format: "7z" };
  }

  // Legacy Office (OLE2 compound file: .doc/.xls/.ppt)
  if (hexAt(bytes, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const ext = fileNameExtension(fileName || "");
    const refined = OLE_CONTAINER_EXTENSION_MIMES[ext];
    return refined
      ? { mime: refined, format: `ole2-${ext}` }
      : { mime: "application/x-ole-storage", format: "ole2" };
  }

  // RTF
  if (asciiAt(bytes, 0, "{\\rtf")) {
    return { mime: "application/rtf", format: "rtf" };
  }

  // Plain text (catch-all for source/config/markup — including HTML and SVG,
  // which deliberately land on text/plain: source view or download, never
  // browser-interpreted).
  if (looksLikeText(bytes)) {
    return { mime: refineTextMime(fileName), format: "utf8-text" };
  }

  return null;
}

function refineTextMime(fileName?: string): string {
  const ext = fileNameExtension(fileName || "");
  return TEXT_EXTENSION_MIMES[ext] ?? "text/plain";
}

export type GeneralUploadVerdict =
  | { ok: true; sizeBytes: number; mime: string; format: string }
  | {
      ok: false;
      reason: "empty_object" | "too_large";
      /** Log-safe explanation (sizes only — never object contents). */
      detail: string;
      sizeBytes: number;
    };

/** Pure accept decision over already-fetched size + head bytes. */
export function evaluateGeneralUploadContent(args: {
  sizeBytes: number;
  headBytes: Uint8Array;
  maxBytes: number;
  fileName?: string;
}): GeneralUploadVerdict {
  const { sizeBytes, headBytes, maxBytes, fileName } = args;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return {
      ok: false,
      reason: "empty_object",
      detail: `object has no stored bytes (size=${String(sizeBytes)})`,
      sizeBytes,
    };
  }
  if (sizeBytes > maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      detail: `${sizeBytes} bytes exceeds the cap of ${maxBytes} bytes`,
      sizeBytes,
    };
  }
  const sniffed = sniffGeneralUploadFormat(headBytes, fileName);
  return {
    ok: true,
    sizeBytes,
    mime: sniffed?.mime ?? "application/octet-stream",
    format: sniffed?.format ?? "unknown-binary",
  };
}

/** Fetch size + head through `reader` and evaluate. Mirrors
 * verifyUploadObjectContent for the general-file policy. */
export async function verifyGeneralUploadObjectContent(
  reader: UploadObjectReader,
  opts: { maxBytes: number; fileName?: string },
): Promise<GeneralUploadVerdict> {
  const sizeBytes = await reader.getSizeBytes();
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > opts.maxBytes) {
    return evaluateGeneralUploadContent({
      sizeBytes,
      headBytes: new Uint8Array(0),
      maxBytes: opts.maxBytes,
      fileName: opts.fileName,
    });
  }
  const headBytes = await reader.readHead(Math.min(UPLOAD_SNIFF_HEAD_BYTES, sizeBytes));
  return evaluateGeneralUploadContent({
    sizeBytes,
    headBytes,
    maxBytes: opts.maxBytes,
    fileName: opts.fileName,
  });
}
