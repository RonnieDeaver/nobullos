import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2, Upload, AlertCircle, CheckCircle2, Image as ImageIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

const EMOJI_NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BYTES = 256 * 1024;

interface CustomEmojiItem {
  id: string;
  name: string;
  imageUrl: string;
  createdAt: string;
  createdByName?: string;
}

export function CustomEmojiManager({ className }: { className?: string }) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CustomEmojiItem | null>(null);

  const { data: emojis = [], isLoading } = useQuery<CustomEmojiItem[]>({
    queryKey: ["/api/comms/emoji"],
    queryFn: () =>
      fetch("/api/comms/emoji", { credentials: "include" }).then((r) =>
        r.ok ? r.json() : [],
      ),
    staleTime: 30_000,
  });

  const filteredEmojis = searchQuery
    ? emojis.filter((e) => e.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : emojis;

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const resp = await fetch(`/api/comms/emoji/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!resp.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/emoji"] }); // fire-and-forget: cache refresh only
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ emojiName, emojiFile }: { emojiName: string; emojiFile: File }) => {
      const fd = new FormData();
      fd.append("name", emojiName);
      fd.append("image", emojiFile);
      const resp = await fetch("/api/comms/emoji", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error ?? "Upload failed");
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/emoji"] }); // fire-and-forget: cache refresh only
      setName("");
      setFile(null);
      setPreview(null);
      setSuccessMsg("Emoji uploaded successfully!");
      setTimeout(() => setSuccessMsg(null), 3000);
    },
  });

  const acceptFile = (f: File | null) => {
    setFileError(null);
    if (!f) { setFile(null); setPreview(null); return; }
    if (!ALLOWED_TYPES.includes(f.type)) {
      setFileError("Only PNG, JPEG, GIF, and WebP images are allowed.");
      setFile(null); setPreview(null); return;
    }
    if (f.size > MAX_BYTES) {
      setFileError("Image must be 256 KB or smaller.");
      setFile(null); setPreview(null); return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => setPreview(ev.target?.result as string);
    reader.readAsDataURL(f);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0] ?? null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files?.[0] ?? null);
  };

  const handleNameChange = (v: string) => {
    setName(v);
    if (v && !EMOJI_NAME_RE.test(v)) {
      setNameError("2–64 chars, letters, numbers, _ or - only.");
    } else {
      setNameError(null);
    }
  };

  const handleUpload = () => {
    setSuccessMsg(null);
    let ok = true;
    if (!EMOJI_NAME_RE.test(name)) {
      setNameError("2–64 chars, letters, numbers, _ or - only.");
      ok = false;
    }
    if (!file) {
      setFileError("Please select an image.");
      ok = false;
    }
    if (!ok) return;
    uploadMutation.mutate({ emojiName: name, emojiFile: file! });
  };

  return (
    <div className={cn("space-y-6", className)} data-testid="custom-emoji-manager">
      {/* Upload form */}
      <div className="border border-border rounded-xl p-4 space-y-4 bg-card">
        <h3 className="text-sm font-semibold text-foreground">Add Custom Emoji</h3>

        <div className="space-y-1">
          <Label htmlFor="emoji-name-input" className="text-xs text-muted-foreground">
            Name (used as :name:)
          </Label>
          <Input
            id="emoji-name-input"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="e.g. party-parrot"
            className={cn("h-8 text-sm font-mono", nameError && "border-destructive")}
            data-testid="emoji-name-input"
          />
          {nameError && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {nameError}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Renders as <code className="font-mono bg-muted px-1 rounded">:{name || "name"}:</code> in messages
          </p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            Image (PNG / JPEG / GIF / WebP · max 256 KB)
          </Label>
          <div className="flex gap-3 items-center">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={cn(
                "h-16 w-16 rounded-lg border-2 border-dashed border-border hover:border-primary flex items-center justify-center flex-shrink-0 transition-colors bg-muted/40 hover:bg-muted",
                dragOver && "border-primary bg-primary/10",
                fileError && "border-destructive",
              )}
              data-testid="emoji-image-picker-btn"
            >
              {preview ? (
                <img
                  src={preview}
                  alt="preview"
                  className="h-12 w-12 object-contain rounded-md"
                />
              ) : (
                <ImageIcon className="h-6 w-6 text-muted-foreground/50" />
              )}
            </button>
            <div className="flex-1 space-y-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="h-7"
                data-testid="emoji-browse-button"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Browse…
              </Button>
              {file && (
                <p className="text-xs text-muted-foreground truncate max-w-[180px]">
                  {file.name} ({Math.round(file.size / 1024)} KB)
                </p>
              )}
              {fileError && (
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {fileError}
                </p>
              )}
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={handleFileChange}
            data-testid="emoji-file-input"
          />
        </div>

        {uploadMutation.isError && (
          <p className="text-xs text-destructive flex items-center gap-1">
            <AlertCircle className="h-3.5 w-3.5" />
            {(uploadMutation.error as Error)?.message ?? "Upload failed"}
          </p>
        )}
        {successMsg && (
          <p className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {successMsg}
          </p>
        )}

        <Button
          type="button"
          size="sm"
          onClick={handleUpload}
          disabled={uploadMutation.isPending || !name || !file}
          className="h-8"
          data-testid="emoji-upload-button"
        >
          {uploadMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <Upload className="h-3.5 w-3.5 mr-1.5" />
          )}
          Upload Emoji
        </Button>
      </div>

      {/* Existing emoji list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">
            Custom Emoji
            {!isLoading && (
              <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                ({filteredEmojis.length}{searchQuery ? ` of ${emojis.length}` : ""})
              </span>
            )}
          </h3>
          {emojis.length > 4 && (
            <Input
              placeholder="Search emoji…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 text-xs w-36"
              data-testid="emoji-search-input"
            />
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredEmojis.length === 0 ? (
          <div className="py-8 text-center border border-dashed border-border rounded-xl">
            <p className="text-sm text-muted-foreground">
              {searchQuery ? `No emoji matching "${searchQuery}"` : "No custom emoji yet"}
            </p>
            {!searchQuery && <p className="text-xs text-muted-foreground mt-1">Upload one above to get started</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1.5">
            {filteredEmojis.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-3 px-3 py-2 border border-border rounded-lg bg-card hover:bg-muted/30 transition-colors group"
                data-testid={`custom-emoji-row-${e.name}`}
              >
                <img
                  src={e.imageUrl}
                  alt={`:${e.name}:`}
                  className="w-8 h-8 object-contain rounded flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground font-mono">:{e.name}:</p>
                  {e.createdByName && (
                    <p className="text-xs text-muted-foreground">by {e.createdByName}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  aria-label={`Delete custom emoji ${e.name}`}
                  onClick={() => setDeleteTarget(e)}
                  disabled={deleteMutation.isPending}
                  data-testid={`emoji-delete-${e.name}`}
                >
                  {deleteMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent data-testid="emoji-delete-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom emoji?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? (
                <>
                  <code className="font-mono">:{deleteTarget.name}:</code> will be removed for
                  everyone. Messages that used it will show the plain text name instead.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="emoji-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="emoji-delete-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
