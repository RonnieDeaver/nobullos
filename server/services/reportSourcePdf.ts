import { Readable } from "stream";
import {
  ObjectStorageService,
  ObjectNotFoundError,
} from "../replit_integrations/object_storage/objectStorage";

// Task #2652 — persist a private copy of a report's source PDF so that
// "Re-parse from Source" keeps working after the original (temporary Zapier
// S3) link expires. All helpers here perform external object-storage I/O ONLY
// — callers must invoke them OUTSIDE any held DB scope (DB Hold Rule) and treat
// a failed save as non-fatal to the import.

/**
 * Deterministic, per-report object key. Re-imports overwrite the same key so
 * the saved copy is always the most-recently-parsed source binary (idempotent).
 */
export function reportSourcePdfKey(reportId: string): string {
  return `report-source-pdfs/${reportId}.pdf`;
}

/**
 * Best-effort upload of a report's source PDF to private object storage.
 * Returns the stored object key on success, or null if the upload failed
 * (the caller logs a warning and the import still succeeds).
 */
export async function saveReportSourcePdf(
  reportId: string,
  buffer: Buffer,
): Promise<string | null> {
  try {
    const key = reportSourcePdfKey(reportId);
    const svc = new ObjectStorageService();
    const body = Readable.from(buffer);
    await svc.streamUploadToPrivateKey(key, body, "application/pdf");
    return key;
  } catch (err: any) {
    console.warn(
      `[ReportSourcePdf] Failed to save source PDF for report ${reportId}: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Downloads a previously-saved source PDF by its object key. Returns the
 * buffer, or null when the object no longer exists (ObjectNotFoundError) or
 * the download fails. Callers fall back to the original source URL / a clear
 * "upload manually" message when this returns null.
 */
export async function loadReportSourcePdf(
  objectKey: string,
): Promise<Buffer | null> {
  try {
    const svc = new ObjectStorageService();
    const file = await svc.getPrivateObjectFileByKey(objectKey);
    const { auditedDownload } = await import(
      "../replit_integrations/object_storage/audit"
    );
    const [buf] = await auditedDownload(file);
    return buf;
  } catch (err: any) {
    if (err instanceof ObjectNotFoundError) return null;
    console.warn(
      `[ReportSourcePdf] Failed to load saved source PDF ${objectKey}: ${err?.message || err}`,
    );
    return null;
  }
}
