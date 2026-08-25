// ClickUp admin — task attachments gallery tab.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Download, File, Image, Loader2, Trash2, Upload, X } from "lucide-react";
import type { Attachment } from "./types";
import { fmtBytes, isImageMime, proxyUrl, thumbProxyUrl } from "./lib";

// ─── Attachments tab ─────────────────────────────────────────────────────────

export function AttachmentsTab({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [previewAtt, setPreviewAtt] = useState<Attachment | null>(null);

  const { data, isLoading, error } = useQuery<{ attachments: Attachment[] }>({
    queryKey: ["/api/clickup/tasks", taskId, "attachments"],
    queryFn: async () => {
      const res = await fetch(`/api/clickup/tasks/${taskId}/attachments`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to load attachments (${res.status})`);
      return res.json();
    },
    retry: 1,
  });

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const MAX = 25 * 1024 * 1024;
      if (file.size > MAX) throw new Error(`File too large — max 25 MB (got ${fmtBytes(file.size)})`);
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/clickup/tasks/${taskId}/attachments`, {
        method: "POST",
        credentials: "include",
        body: form,
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Upload failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/clickup/tasks", taskId, "attachments"],
      });
      toast({ title: "File uploaded" });
    },
    onError: (e: any) =>
      toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (att: Attachment) => {
      const res = await fetch(
        `/api/clickup/tasks/${taskId}/attachments/${att.id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Delete failed (${res.status})`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/clickup/tasks", taskId, "attachments"],
      });
      toast({ title: "Attachment removed" });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadMut.mutate(file);
    e.target.value = "";
  };

  const attachments = data?.attachments ?? [];

  return (
    <div className="space-y-3 pt-2" data-testid="tab-content-attachments">
      {/* Upload button */}
      <div className="flex items-center gap-2">
        <label
          className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border cursor-pointer
            ${uploadMut.isPending
              ? "opacity-50 pointer-events-none bg-muted/50 border-border text-muted-foreground"
              : "bg-card border-border text-foreground hover:bg-muted/50"
            }`}
          data-testid="label-upload-attachment"
        >
          {uploadMut.isPending ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Upload className="w-3 h-3" />
          )}
          {uploadMut.isPending ? "Uploading…" : "Upload file"}
          <input
            type="file"
            className="sr-only"
            onChange={handleFileChange}
            disabled={uploadMut.isPending}
            data-testid="input-upload-file"
          />
        </label>
        <span className="text-[10px] text-muted-foreground">Max 25 MB</span>
      </div>

      {/* States */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="loading-attachments">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading attachments…
        </div>
      )}
      {error && (
        <p className="text-xs text-red-500" data-testid="error-attachments">
          {(error as Error).message}
        </p>
      )}
      {!isLoading && !error && attachments.length === 0 && (
        <p className="text-xs text-muted-foreground italic" data-testid="text-no-attachments">
          No attachments yet
        </p>
      )}

      {/* Gallery */}
      {attachments.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="gallery-attachments">
          {attachments.map((att) => (
            <div
              key={att.id}
              className="group relative border rounded overflow-hidden bg-muted/50 hover:border-purple-300 transition-colors"
              data-testid={`attachment-card-${att.id}`}
            >
              {/* Thumbnail / icon */}
              {isImageMime(att.mimetype) ? (
                <button
                  className="w-full aspect-square flex items-center justify-center overflow-hidden"
                  onClick={() => setPreviewAtt(att)}
                  data-testid={`button-preview-${att.id}`}
                  title="Preview"
                >
                  <img
                    src={thumbProxyUrl(att)}
                    alt={att.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="w-full aspect-square flex flex-col items-center justify-center gap-1 text-gray-300">
                  <File className="w-8 h-8" />
                  <span className="text-[9px] uppercase text-muted-foreground">
                    {att.extension || att.name.split(".").pop() || "file"}
                  </span>
                </div>
              )}

              {/* Actions overlay */}
              <div className="absolute inset-x-0 bottom-0 bg-card/90 border-t flex items-center gap-1 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="text-[9px] text-muted-foreground flex-1 truncate" title={att.name}>
                  {att.name}
                </span>
                <a
                  href={proxyUrl(att, true)}
                  download={att.name}
                  className="flex-shrink-0 text-muted-foreground hover:text-purple-600"
                  title="Download"
                  data-testid={`link-download-${att.id}`}
                >
                  <Download className="w-3 h-3" />
                </a>
                <ConfirmActionDialog
                  trigger={
                    <button
                      className="flex-shrink-0 text-muted-foreground hover:text-red-600"
                      title="Delete"
                      data-testid={`button-delete-${att.id}`}
                      disabled={deleteMut.isPending}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  }
                  title={`Delete "${att.name}"?`}
                  description="This permanently removes the attachment from the ClickUp task for everyone. This cannot be undone."
                  confirmLabel="Delete"
                  onConfirm={() => deleteMut.mutate(att)}
                  testId={`dialog-delete-attachment-${att.id}`}
                />
              </div>

              {/* Size badge */}
              <div className="absolute top-1 right-1 bg-black/50 text-white text-[8px] px-1 rounded">
                {fmtBytes(att.size)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Image preview modal */}
      {previewAtt && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPreviewAtt(null)}
          data-testid="overlay-image-preview"
        >
          <div
            className="relative max-w-3xl w-full bg-card rounded-lg overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-sm font-medium text-foreground truncate">{previewAtt.name}</span>
              <div className="flex items-center gap-2">
                <a
                  href={proxyUrl(previewAtt, true)}
                  download={previewAtt.name}
                  className="text-xs text-purple-600 hover:underline flex items-center gap-1"
                  data-testid="link-preview-download"
                >
                  <Download className="w-3 h-3" /> Download
                </a>
                <button
                  onClick={() => setPreviewAtt(null)}
                  className="text-muted-foreground hover:text-foreground"
                  data-testid="button-close-preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="p-2 flex items-center justify-center bg-muted/50 min-h-[200px] max-h-[70vh] overflow-auto">
              <img
                src={proxyUrl(previewAtt)}
                alt={previewAtt.name}
                className="max-w-full max-h-full object-contain"
                data-testid="img-preview-full"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

