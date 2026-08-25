// Task #4023 — in-app preview for images, PDF, video, audio and plain text;
// everything else gets a download prompt. Media loads through the
// authenticated same-origin download route with disposition=inline — the
// server only ever serves whitelisted mimes inline (never html/svg).
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Loader2 } from "lucide-react";
import {
  classifyClientFileKind,
  formatByteSize,
  isInlinePreviewableMime,
} from "@shared/clientFiles";
import { FileKindIcon } from "./fileKind";
import { downloadUrl, type FileRow } from "./types";

const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

function TextPreview({ url, sizeBytes }: { url: string; sizeBytes: number }) {
  const [state, setState] = useState<{
    loading: boolean;
    text?: string;
    error?: string;
  }>({ loading: true });

  useEffect(() => {
    if (sizeBytes > TEXT_PREVIEW_MAX_BYTES) {
      setState({
        loading: false,
        error: "Too large to preview — download to view.",
      });
      return;
    }
    let cancelled = false;
    fetch(url, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const text = await res.text();
        if (!cancelled) setState({ loading: false, text });
      })
      .catch((err) => {
        if (!cancelled)
          setState({ loading: false, error: err?.message ?? "Failed to load" });
      });
    return () => {
      cancelled = true;
    };
  }, [url, sizeBytes]);

  if (state.loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-primary/50" />
      </div>
    );
  }
  if (state.error) {
    return (
      <p className="text-sm text-muted-foreground text-center py-10">{state.error}</p>
    );
  }
  return (
    <pre className="text-xs whitespace-pre-wrap break-words bg-muted/50 border border-border rounded-md p-3 max-h-[60vh] overflow-auto font-mono">
      {state.text}
    </pre>
  );
}

export function FilePreviewDialog({
  clientId,
  file,
  onClose,
}: {
  clientId: string;
  file: FileRow | null;
  onClose: () => void;
}) {
  if (!file) return null;
  const kind = classifyClientFileKind(file.mimeType, file.name);
  const canInline = isInlinePreviewableMime(file.mimeType);
  const inlineUrl = downloadUrl(clientId, file.id, "inline");
  const attachmentUrl = downloadUrl(clientId, file.id);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-4xl"
        data-testid="dialog-file-preview"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8 break-all">
            <FileKindIcon mimeType={file.mimeType} fileName={file.name} />
            {file.name}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3">
            <span>{formatByteSize(file.sizeBytes)}</span>
            <Button
              asChild
              size="sm"
              variant="outline"
              className="h-7"
              data-testid="button-preview-download"
            >
              <a href={attachmentUrl}>
                <Download className="w-3.5 h-3.5 mr-1" />
                Download
              </a>
            </Button>
          </DialogDescription>
        </DialogHeader>

        {!canInline ? (
          <div className="py-12 text-center space-y-3">
            <FileKindIcon
              mimeType={file.mimeType}
              fileName={file.name}
              className="w-12 h-12 mx-auto"
            />
            <p className="text-sm text-muted-foreground">
              No in-app preview for this file type — use Download to view it.
            </p>
          </div>
        ) : kind === "image" ? (
          <div className="flex justify-center bg-muted/50 rounded-md p-2">
            <img
              src={inlineUrl}
              alt={file.name}
              className="max-h-[65vh] max-w-full object-contain rounded"
            />
          </div>
        ) : kind === "video" ? (
          <video
            src={inlineUrl}
            controls
            className="w-full max-h-[65vh] rounded-md bg-black"
          />
        ) : kind === "audio" ? (
          <div className="py-10 px-4">
            <audio src={inlineUrl} controls className="w-full" />
          </div>
        ) : kind === "pdf" ? (
          <iframe
            src={inlineUrl}
            title={file.name}
            className="w-full h-[70vh] rounded-md border border-border bg-card"
          />
        ) : (
          <TextPreview url={inlineUrl} sizeBytes={file.sizeBytes} />
        )}
      </DialogContent>
    </Dialog>
  );
}
