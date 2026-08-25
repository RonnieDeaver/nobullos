// Task #4023 — multi-file upload queue: mint → direct PUT (XHR for
// progress) → claim. The signed URL receives ONLY the bytes and a
// Content-Type header — no cookies or auth headers ever go to storage.
import { useCallback, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { filesBase } from "./types";

export interface UploadItem {
  key: string;
  fileName: string;
  /** 0..100 across the PUT phase. */
  progress: number;
  status: "queued" | "uploading" | "claiming" | "done" | "error";
  error?: string;
  supersededVersionNumber?: number;
}

const CONCURRENCY = 3;

function putWithProgress(
  uploadUrl: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Storage upload failed (network)"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
}

export function useClientFileUpload(
  clientId: string,
  opts: {
    /** Called after EACH successful claim (invalidate queries). */
    onFileDone?: (info: { supersededVersionNumber?: number; fileName: string }) => void;
    /** Called once when the whole batch settles. */
    onBatchSettled?: () => void;
  } = {},
) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);

  const patchItem = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.key === key ? { ...it, ...patch } : it)),
    );
  }, []);

  const uploadFiles = useCallback(
    async (files: File[], folderId: string | null) => {
      if (files.length === 0) return;
      const batch = files.map((file) => ({
        file,
        key: `u${Date.now()}-${seq.current++}`,
      }));
      setItems((prev) => [
        ...prev.filter((it) => it.status !== "done"),
        ...batch.map(({ file, key }) => ({
          key,
          fileName: file.name,
          progress: 0,
          status: "queued" as const,
        })),
      ]);

      const queue = [...batch];
      const runOne = async () => {
        const next = queue.shift();
        if (!next) return;
        const { file, key } = next;
        try {
          patchItem(key, { status: "uploading" });
          const mintRes = await apiRequest(
            "POST",
            `${filesBase(clientId)}/upload-url`,
            { fileName: file.name },
          );
          const { uploadUrl, objectPath, maxBytes } = await mintRes.json();
          if (typeof maxBytes === "number" && file.size > maxBytes) {
            throw new Error(
              `File exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit`,
            );
          }
          await putWithProgress(uploadUrl, file, (pct) =>
            patchItem(key, { progress: pct }),
          );
          patchItem(key, { status: "claiming", progress: 100 });
          const claimRes = await apiRequest(
            "POST",
            `${filesBase(clientId)}/claim`,
            { objectPath, fileName: file.name, folderId },
          );
          const claimed = await claimRes.json();
          patchItem(key, {
            status: "done",
            supersededVersionNumber: claimed?.supersededVersionNumber,
          });
          opts.onFileDone?.({
            supersededVersionNumber: claimed?.supersededVersionNumber,
            fileName: file.name,
          });
        } catch (err: any) {
          patchItem(key, {
            status: "error",
            error: err?.message ?? "Upload failed",
          });
        }
        await runOne();
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, runOne),
      );
      opts.onBatchSettled?.();
    },
    [clientId, opts, patchItem],
  );

  const dismissItem = useCallback((key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  const clearSettled = useCallback(() => {
    setItems((prev) =>
      prev.filter((it) => it.status !== "done" && it.status !== "error"),
    );
  }, []);

  const busy = items.some(
    (it) =>
      it.status === "queued" ||
      it.status === "uploading" ||
      it.status === "claiming",
  );

  return { items, uploadFiles, dismissItem, clearSettled, busy };
}
