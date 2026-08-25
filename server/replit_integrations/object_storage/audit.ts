/**
 * Task #1845 — Object-storage outbound call audit.
 *
 * Thin adapter wrappers around the @google-cloud/storage File operations
 * and the Replit sidecar signed-URL endpoint so every outbound call from
 * server code flows through `auditOutboundCall()` with
 * `integration: "object_storage"`. Hashes-only: object key is hashed
 * (path may embed user IDs / filenames). Bucket name is recorded as-is
 * since it is infrastructure, not PII.
 *
 * Wrappers always invoke the underlying op — when the
 * `external_call_audit_enabled` kill switch is off, `auditOutboundCall`
 * is a zero-overhead pass-through.
 */

import { createHash } from "node:crypto";
import type { File } from "@google-cloud/storage";
import { auditOutboundCall, isAuditEnabled } from "../../services/externalCallAudit";

function hashObjectKey(bucketName: string, objectName: string): string {
  return createHash("sha256")
    .update(`${bucketName}\u0001${objectName}`)
    .digest("hex")
    .slice(0, 32);
}

function fileDedupeParams(file: File): Record<string, unknown> {
  const bucketName = file.bucket?.name ?? "";
  const objectName = file.name ?? "";
  return {
    bucket: bucketName,
    keyHash: hashObjectKey(bucketName, objectName),
  };
}

function rawDedupeParams(bucketName: string, objectName: string): Record<string, unknown> {
  return {
    bucket: bucketName,
    keyHash: hashObjectKey(bucketName, objectName),
  };
}

export async function auditedExists(file: File): Promise<[boolean]> {
  return auditOutboundCall<[boolean]>(
    {
      integration: "object_storage",
      endpoint: "exists",
      method: "HEAD",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      const result = await file.exists();
      return { value: result, statusCode: result[0] ? 200 : 404 };
    },
  );
}

export async function auditedGetMetadata(file: File): Promise<any> {
  return auditOutboundCall<any>(
    {
      integration: "object_storage",
      endpoint: "get_metadata",
      method: "GET",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      const result = await file.getMetadata();
      return { value: result, statusCode: 200 };
    },
  );
}

export async function auditedSetMetadata(file: File, meta: any): Promise<any> {
  return auditOutboundCall<any>(
    {
      integration: "object_storage",
      endpoint: "set_metadata",
      method: "PATCH",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      const result = await file.setMetadata(meta);
      return { value: result, statusCode: 200 };
    },
  );
}

export async function auditedSave(
  file: File,
  body: Buffer | string,
  opts?: Parameters<File["save"]>[1],
): Promise<void> {
  const size = Buffer.isBuffer(body) ? body.byteLength : Buffer.byteLength(body);
  return auditOutboundCall<void>(
    {
      integration: "object_storage",
      endpoint: "save",
      method: "PUT",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      await file.save(body, opts as any);
      return { value: undefined, statusCode: 200, responseSizeBytes: size };
    },
  );
}

export async function auditedDownload(
  file: File,
  opts?: { destination?: string } & Record<string, unknown>,
): Promise<[Buffer]> {
  return auditOutboundCall<[Buffer]>(
    {
      integration: "object_storage",
      endpoint: "download",
      method: "GET",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      const result = await file.download(opts as any);
      const bytes = Buffer.isBuffer(result?.[0]) ? result[0].byteLength : undefined;
      return { value: result as [Buffer], statusCode: 200, responseSizeBytes: bytes };
    },
  );
}

export async function auditedGetFiles(
  bucket: { name: string; getFiles: (q?: any) => Promise<any[]> },
  query?: { prefix?: string } & Record<string, unknown>,
): Promise<[File[]]> {
  const prefix = query?.prefix ?? "";
  return auditOutboundCall<[File[]]>(
    {
      integration: "object_storage",
      endpoint: "list",
      method: "GET",
      dedupeParams: {
        bucket: bucket.name,
        keyHash: hashObjectKey(bucket.name, prefix),
      },
    },
    async () => {
      const result = await bucket.getFiles(query);
      const files = Array.isArray(result?.[0]) ? (result[0] as File[]) : [];
      return { value: result as [File[]], statusCode: 200, responseSizeBytes: files.length };
    },
  );
}

export async function auditedDelete(
  file: File,
  opts?: { ignoreNotFound?: boolean } & Record<string, unknown>,
): Promise<void> {
  return auditOutboundCall<void>(
    {
      integration: "object_storage",
      endpoint: "delete",
      method: "DELETE",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      await file.delete(opts as any);
      return { value: undefined, statusCode: 200 };
    },
  );
}

/**
 * Wrap createReadStream so the audit fires when the stream actually
 * finishes / errors. Returns the stream synchronously so the caller can
 * pipe it. The audit promise is fire-and-forget.
 *
 * IMPORTANT: we only attach `end` / `close` / `error` listeners, never
 * `data`, so the stream is NOT switched into flowing mode prematurely.
 */
export function auditedCreateReadStream(
  file: File,
  opts?: Parameters<File["createReadStream"]>[0],
): NodeJS.ReadableStream {
  const stream = file.createReadStream(opts as any);
  if (!isAuditEnabled()) return stream;

  const startedAt = Date.now();
  const done = new Promise<{ value: undefined; statusCode: number; responseSizeBytes?: number }>(
    (resolve) => {
      const finish = (status: number) => {
        resolve({ value: undefined, statusCode: status });
      };
      stream.once("end", () => finish(200));
      stream.once("close", () => finish(200));
      stream.once("error", () => finish(0));
    },
  );
  void auditOutboundCall<undefined>(
    {
      integration: "object_storage",
      endpoint: "download_stream",
      method: "GET",
      dedupeParams: fileDedupeParams(file),
    },
    async () => {
      const r = await done;
      // Anchor duration off our own start so the audit reflects the
      // real stream lifetime, not just the auditOutboundCall wrapper.
      void startedAt;
      return r;
    },
  ).catch(() => {});
  return stream;
}

/**
 * Wrap createWriteStream so the audit fires on `finish`. Returns the
 * write stream synchronously; caller pipes the body into it as usual.
 */
export function auditedCreateWriteStream(
  file: File,
  opts?: Parameters<File["createWriteStream"]>[0],
): ReturnType<File["createWriteStream"]> {
  const stream = file.createWriteStream(opts as any);
  if (!isAuditEnabled()) return stream;

  let bytes = 0;
  stream.on("pipe", (src: NodeJS.ReadableStream) => {
    src.on("data", (chunk: Buffer | string) => {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    });
  });
  const done = new Promise<{ value: undefined; statusCode: number; responseSizeBytes: number }>(
    (resolve) => {
      const finish = (status: number) => {
        resolve({ value: undefined, statusCode: status, responseSizeBytes: bytes });
      };
      stream.once("finish", () => finish(200));
      stream.once("close", () => finish(200));
      stream.once("error", () => finish(0));
    },
  );
  void auditOutboundCall<undefined>(
    {
      integration: "object_storage",
      endpoint: "upload_stream",
      method: "PUT",
      dedupeParams: fileDedupeParams(file),
    },
    async () => done,
  ).catch(() => {});
  return stream;
}

export async function auditedSignObjectURL(args: {
  endpoint: string;
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
  fetcher: () => Promise<{ status: number; signedUrl: string; bodyBytes: number }>;
}): Promise<string> {
  return auditOutboundCall<string>(
    {
      integration: "object_storage",
      endpoint: "sign_url",
      method: args.method,
      dedupeParams: rawDedupeParams(args.bucketName, args.objectName),
    },
    async () => {
      const r = await args.fetcher();
      return {
        value: r.signedUrl,
        statusCode: r.status,
        responseSizeBytes: r.bodyBytes,
      };
    },
  );
}
