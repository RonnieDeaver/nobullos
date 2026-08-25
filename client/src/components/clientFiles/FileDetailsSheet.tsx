// Task #4023 — file details side panel: metadata, prior versions
// (download / restore) and the per-file activity trail.
// Task #4028 — external share links: mint with expiry, copy, list, revoke.
// Task #4040 — replace & copy: re-mint a lost active link in one click.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, Download, History, Link2, Loader2, RotateCcw, X } from "lucide-react";
import {
  formatByteSize,
  shareLinkStatus,
  CLIENT_FILE_SHARE_DEFAULT_DAYS,
  CLIENT_FILE_SHARE_EXPIRY_CHOICES_DAYS,
} from "@shared/clientFiles";
import { FileKindIcon } from "./fileKind";
import {
  describeActivity,
  filesBase,
  formatWhen,
  versionDownloadUrl,
  type FileDetailResponse,
  type ShareListResponse,
} from "./types";

export function FileDetailsSheet({
  clientId,
  fileId,
  onClose,
}: {
  clientId: string;
  fileId: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const detailKey = fileId ? [`${filesBase(clientId)}/${fileId}`] : null;
  const sharesKey = fileId ? [`${filesBase(clientId)}/${fileId}/shares`] : null;
  const [expiryDays, setExpiryDays] = useState(String(CLIENT_FILE_SHARE_DEFAULT_DAYS));

  const { data: sharesData } = useQuery<ShareListResponse>({
    queryKey: sharesKey ?? ["client-file-shares-none"],
    enabled: !!fileId,
  });

  const copyShareUrl = async (path: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      toast({ title: "Link copied" });
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: `${window.location.origin}${path}`,
      });
    }
  };

  const createShare = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        `${filesBase(clientId)}/${fileId}/shares`,
        { expiresInDays: Number(expiryDays) },
      );
      return res.json() as Promise<{ token: string; path: string }>;
    },
    onSuccess: (data) => {
      void copyShareUrl(data.path);
      if (sharesKey) void queryClient.invalidateQueries({ queryKey: sharesKey });
      if (detailKey) void queryClient.invalidateQueries({ queryKey: detailKey });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't create share link",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  // Task #4040 — raw tokens are unrecoverable (DB keeps only the hash), so
  // "copy again" = replace: revoke + re-mint in one click, same expiry.
  const replaceShare = useMutation({
    mutationFn: async (shareId: string) => {
      const res = await apiRequest(
        "POST",
        `${filesBase(clientId)}/${fileId}/shares/${shareId}/replace`,
        {},
      );
      return res.json() as Promise<{ token: string; path: string }>;
    },
    onSuccess: (data) => {
      void copyShareUrl(data.path);
      if (sharesKey) void queryClient.invalidateQueries({ queryKey: sharesKey });
      if (detailKey) void queryClient.invalidateQueries({ queryKey: detailKey });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't replace link",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  const revokeShare = useMutation({
    mutationFn: async (shareId: string) => {
      const res = await apiRequest(
        "DELETE",
        `${filesBase(clientId)}/${fileId}/shares/${shareId}`,
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Share link revoked" });
      if (sharesKey) void queryClient.invalidateQueries({ queryKey: sharesKey });
      if (detailKey) void queryClient.invalidateQueries({ queryKey: detailKey });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't revoke link",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  const { data, isLoading } = useQuery<FileDetailResponse>({
    queryKey: detailKey ?? ["client-file-detail-none"],
    enabled: !!fileId,
  });

  const restoreVersion = useMutation({
    mutationFn: async (versionId: string) => {
      const res = await apiRequest(
        "POST",
        `${filesBase(clientId)}/${fileId}/versions/${versionId}/restore`,
        {},
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Version restored" });
      // void: fire-and-forget cache invalidation — refetch errors surface via query state
      if (detailKey) void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).startsWith(filesBase(clientId)),
      });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't restore version",
        description: err?.message,
        variant: "destructive",
      });
    },
  });

  const file = data?.file;

  return (
    <Sheet open={!!fileId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full sm:max-w-md overflow-y-auto"
        data-testid="sheet-file-details"
      >
        {isLoading || !file ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 animate-spin text-primary/50" />
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-start gap-2 text-left break-all pr-6">
                <FileKindIcon
                  mimeType={file.mimeType}
                  fileName={file.name}
                  className="w-5 h-5 mt-0.5"
                />
                {file.name}
              </SheetTitle>
              <SheetDescription className="text-left">
                {formatByteSize(file.sizeBytes)} · {file.mimeType}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-1.5 text-sm text-slate-600">
              <div className="flex justify-between gap-4">
                <span className="text-slate-400">Added</span>
                <span>{formatWhen(file.createdAt)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-400">Content updated</span>
                <span>{formatWhen(file.contentUpdatedAt)}</span>
              </div>
              {file.trashedAt && (
                <div className="flex justify-between gap-4">
                  <span className="text-slate-400">Trashed</span>
                  <span>{formatWhen(file.trashedAt)}</span>
                </div>
              )}
            </div>

            <Separator className="my-4" />

            {!file.trashedAt && (
              <>
                <div>
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-2">
                    <Link2 className="w-4 h-4" />
                    Share links
                  </h3>
                  <p className="text-xs text-slate-400 mb-2">
                    Anyone with a link can download this file until it expires
                    — no login needed. The link is copied when created; to
                    copy it again later, use replace — the old link stops
                    working and a fresh one (same expiry) is copied.
                  </p>
                  <div className="flex items-center gap-2 mb-3">
                    <Select value={expiryDays} onValueChange={setExpiryDays}>
                      <SelectTrigger
                        className="h-8 w-32 text-xs"
                        data-testid="select-share-expiry"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CLIENT_FILE_SHARE_EXPIRY_CHOICES_DAYS.map((d) => (
                          <SelectItem key={d} value={String(d)}>
                            {d === 1 ? "1 day" : `${d} days`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground"
                      disabled={createShare.isPending}
                      onClick={() => createShare.mutate()}
                      data-testid="button-create-share-link"
                    >
                      {createShare.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 mr-1.5" />
                      )}
                      Create &amp; copy link
                    </Button>
                  </div>
                  {(sharesData?.shares ?? []).length === 0 ? (
                    <p className="text-xs text-slate-400">No share links yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {(sharesData?.shares ?? []).map((s) => {
                        const status = shareLinkStatus(s);
                        return (
                          <li
                            key={s.id}
                            className="flex items-center justify-between gap-2 text-xs"
                            data-testid={`share-row-${s.id}`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <Badge
                                variant={status === "active" ? "default" : "outline"}
                                className={
                                  status === "active"
                                    ? "bg-emerald-600 hover:bg-emerald-600 text-white shrink-0"
                                    : "text-slate-400 shrink-0"
                                }
                              >
                                {status === "active"
                                  ? "Active"
                                  : status === "revoked"
                                    ? "Revoked"
                                    : "Expired"}
                              </Badge>
                              <span className="text-slate-500 truncate">
                                {status === "active"
                                  ? `expires ${formatWhen(s.expiresAt)}`
                                  : formatWhen(s.revokedAt ?? s.expiresAt)}
                                {" · "}
                                {s.accessCount} download{s.accessCount === 1 ? "" : "s"}
                              </span>
                            </span>
                            {status === "active" && (
                              <span className="flex items-center gap-0.5 shrink-0">
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 shrink-0"
                                  title="Replace &amp; copy link (the old link stops working)"
                                  disabled={replaceShare.isPending}
                                  onClick={() => replaceShare.mutate(s.id)}
                                  data-testid={`button-replace-share-${s.id}`}
                                >
                                  {replaceShare.isPending ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 shrink-0"
                                  title="Revoke this link"
                                  disabled={revokeShare.isPending}
                                  onClick={() => revokeShare.mutate(s.id)}
                                  data-testid={`button-revoke-share-${s.id}`}
                                >
                                  <X className="w-3.5 h-3.5" />
                                </Button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <Separator className="my-4" />
              </>
            )}

            <div>
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5 mb-2">
                <History className="w-4 h-4" />
                Versions
              </h3>
              {(data?.versions ?? []).length === 0 ? (
                <p className="text-xs text-slate-400">
                  No prior versions. Uploading a file with the same name here
                  keeps the old copy as a version.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  <li className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <Badge className="bg-primary text-primary-foreground hover:bg-primary shrink-0">
                        Current
                      </Badge>
                      <span className="text-slate-500 truncate">
                        {formatByteSize(file.sizeBytes)} ·{" "}
                        {formatWhen(file.contentUpdatedAt)}
                      </span>
                    </span>
                  </li>
                  {(data?.versions ?? []).map((v) => (
                    <li
                      key={v.id}
                      className="flex items-center justify-between gap-2 text-sm"
                      data-testid={`version-row-${v.versionNumber}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Badge variant="outline" className="shrink-0">
                          v{v.versionNumber}
                        </Badge>
                        <span className="text-slate-500 truncate">
                          {formatByteSize(v.sizeBytes)} ·{" "}
                          {formatWhen(v.uploadedAt)}
                        </span>
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        <Button
                          asChild
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Download this version"
                        >
                          <a
                            href={versionDownloadUrl(clientId, file.id, v.id)}
                            data-testid={`button-version-download-${v.versionNumber}`}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </Button>
                        {!file.trashedAt && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Restore this version"
                            disabled={restoreVersion.isPending}
                            onClick={() => restoreVersion.mutate(v.id)}
                            data-testid={`button-version-restore-${v.versionNumber}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Separator className="my-4" />

            <div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                Activity
              </h3>
              {(data?.activity ?? []).length === 0 ? (
                <p className="text-xs text-slate-400">No activity yet.</p>
              ) : (
                <ul className="space-y-2">
                  {(data?.activity ?? []).map((a) => (
                    <li key={a.id} className="text-xs">
                      <p className="text-slate-600">{describeActivity(a)}</p>
                      <p className="text-slate-400">{formatWhen(a.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
