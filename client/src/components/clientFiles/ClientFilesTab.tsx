// Task #4023 — "Files" tab on the client page: Drive-style per-client file
// manager on the app's private object storage. Folder navigation with
// breadcrumbs, drag-and-drop multi-file upload with per-file progress,
// list/grid views, sort, client-scoped search, previews, rename/move/bulk
// actions, version history, and a per-client Trash with restore.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronRight,
  Download,
  Eye,
  Folder,
  FolderInput,
  FolderPlus,
  Home,
  Info,
  LayoutGrid,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { formatByteSize, sanitizeClientFileName } from "@shared/clientFiles";
import { FileKindIcon } from "./fileKind";
import DocumentsSection from "@/components/docs/DocumentsSection";
import { useClientFileUpload } from "./useClientFileUpload";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { FileDetailsSheet } from "./FileDetailsSheet";
import { MoveFolderDialog } from "./MoveFolderDialog";
import { fabColliderRef } from "@/lib/fabCollider";
import {
  downloadUrl,
  filesBase,
  formatWhen,
  type BrowseResponse,
  type FileRow,
  type FolderRow,
  type SearchResponse,
  type UsageResponse,
} from "./types";

type SortKey = "name" | "size" | "updated";
type ViewMode = "list" | "grid";

interface MoveTarget {
  kind: "files" | "folder";
  ids: string[];
  label: string;
}

function sortFiles(files: FileRow[], sort: SortKey): FileRow[] {
  const out = [...files];
  if (sort === "size") out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  else if (sort === "updated")
    out.sort(
      (a, b) =>
        new Date(b.contentUpdatedAt).getTime() -
        new Date(a.contentUpdatedAt).getTime(),
    );
  else out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return out;
}

export function ClientFilesTab({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const base = filesBase(clientId);

  const [folderId, setFolderId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortKey>("name");
  const [searchInput, setSearchInput] = useState("");
  const [trashMode, setTrashMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Task #4025: ?file=<id> deep link (communication log / call views link to
  // the in-app copy of a delivered recording or transcript). Handled once on
  // mount: jump to the file's folder + open its details sheet, then strip the
  // param so back/refresh don't re-trigger.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const fileParam = params.get("file");
    if (!fileParam) return;
    deepLinkHandled.current = true;
    // Fire-and-forget: deep-link resolution failure just leaves the default view (handled inside).
    void (async () => {
      try {
        const res = await apiRequest("GET", `${base}/${fileParam}`);
        const detail = await res.json();
        const folder = detail?.file?.folderId ?? null;
        setFolderId(folder);
        setDetailsFileId(fileParam);
      } catch {
        toast({
          title: "File not found",
          description: "The linked file may have been deleted.",
          variant: "destructive",
        });
      } finally {
        const url = new URL(window.location.href);
        url.searchParams.delete("file");
        window.history.replaceState(null, "", url.toString());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<
    { kind: "file" | "folder"; id: string; name: string } | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [previewFile, setPreviewFile] = useState<FileRow | null>(null);
  const [detailsFileId, setDetailsFileId] = useState<string | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderRow | null>(null);
  const [purgeIds, setPurgeIds] = useState<string[] | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const searchQ = searchInput.trim();
  const searching = searchQ.length >= 2;

  const invalidateAll = useCallback(() => {
    // void: fire-and-forget cache invalidation — refetch errors surface via query state
    void queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0] as string).startsWith(base),
    });
  }, [queryClient, base]);

  // ── Queries ──────────────────────────────────────────────────────────
  const browseKey = [`${base}/browse?folderId=${folderId ?? ""}`];
  const { data: browse, isLoading: browseLoading } = useQuery<BrowseResponse>({
    queryKey: browseKey,
    enabled: !trashMode && !searching,
  });
  const { data: tree } = useQuery<{ folders: FolderRow[] }>({
    queryKey: [`${base}/tree`],
  });
  const { data: trash, isLoading: trashLoading } = useQuery<{ files: FileRow[] }>({
    queryKey: [`${base}/trash`],
    enabled: trashMode,
  });
  const { data: usage } = useQuery<UsageResponse>({
    queryKey: [`${base}/usage`],
  });
  const { data: searchData, isLoading: searchLoading } = useQuery<SearchResponse>({
    queryKey: [`${base}/search?q=${encodeURIComponent(searchQ)}`],
    enabled: searching && !trashMode,
  });

  const upload = useClientFileUpload(clientId, {
    onFileDone: ({ supersededVersionNumber, fileName }) => {
      invalidateAll();
      if (supersededVersionNumber) {
        toast({
          title: `Kept previous copy of “${fileName}”`,
          description: `The old file is saved as version ${supersededVersionNumber} — restorable from file details.`,
        });
      }
    },
    onBatchSettled: invalidateAll,
  });

  // ── Mutations ────────────────────────────────────────────────────────
  const onErrorToast = (title: string) => (err: any) =>
    toast({ title, description: err?.message, variant: "destructive" });

  const createFolder = useMutation({
    mutationFn: async (name: string) =>
      (await apiRequest("POST", `${base}/folders`, { name, parentId: folderId })).json(),
    onSuccess: () => {
      setNewFolderOpen(false);
      setNewFolderName("");
      invalidateAll();
    },
    onError: onErrorToast("Couldn't create folder"),
  });

  const renameMutation = useMutation({
    mutationFn: async (args: { kind: "file" | "folder"; id: string; name: string }) => {
      const url =
        args.kind === "file" ? `${base}/${args.id}` : `${base}/folders/${args.id}`;
      return (await apiRequest("PATCH", url, { name: args.name })).json();
    },
    onSuccess: () => {
      setRenameTarget(null);
      invalidateAll();
    },
    onError: onErrorToast("Couldn't rename"),
  });

  const moveMutation = useMutation({
    mutationFn: async (args: { target: MoveTarget; destination: string | null }) => {
      if (args.target.kind === "folder") {
        return (
          await apiRequest("PATCH", `${base}/folders/${args.target.ids[0]}`, {
            parentId: args.destination,
          })
        ).json();
      }
      return (
        await apiRequest("POST", `${base}/move`, {
          fileIds: args.target.ids,
          folderId: args.destination,
        })
      ).json();
    },
    onSuccess: () => {
      setMoveTarget(null);
      setSelected(new Set());
      invalidateAll();
    },
    onError: onErrorToast("Couldn't move"),
  });

  const deleteFolderMutation = useMutation({
    mutationFn: async (id: string) =>
      (await apiRequest("DELETE", `${base}/folders/${id}`)).json(),
    onSuccess: (res: { trashedFileCount?: number }) => {
      setDeleteFolderTarget(null);
      invalidateAll();
      toast({
        title: "Folder deleted",
        description:
          res?.trashedFileCount
            ? `${res.trashedFileCount} file${res.trashedFileCount === 1 ? "" : "s"} moved to Trash.`
            : undefined,
      });
    },
    onError: onErrorToast("Couldn't delete folder"),
  });

  const trashMutation = useMutation({
    mutationFn: async (fileIds: string[]) =>
      (await apiRequest("POST", `${base}/trash-files`, { fileIds })).json(),
    onSuccess: (res: { trashed?: number }) => {
      setSelected(new Set());
      invalidateAll();
      toast({
        title: `Moved ${res?.trashed ?? ""} file${res?.trashed === 1 ? "" : "s"} to Trash`,
      });
    },
    onError: onErrorToast("Couldn't move to Trash"),
  });

  const restoreMutation = useMutation({
    mutationFn: async (fileIds: string[]) =>
      (await apiRequest("POST", `${base}/restore`, { fileIds })).json(),
    onSuccess: () => {
      setSelected(new Set());
      invalidateAll();
      toast({ title: "Restored" });
    },
    onError: onErrorToast("Couldn't restore"),
  });

  const purgeMutation = useMutation({
    mutationFn: async (fileIds: string[]) =>
      (await apiRequest("POST", `${base}/purge`, { fileIds })).json(),
    onSuccess: () => {
      setPurgeIds(null);
      setSelected(new Set());
      invalidateAll();
      toast({ title: "Permanently deleted" });
    },
    onError: onErrorToast("Couldn't delete permanently"),
  });

  const emptyTrashMutation = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `${base}/empty-trash`, {})).json(),
    onSuccess: () => {
      setEmptyTrashOpen(false);
      invalidateAll();
      toast({ title: "Trash emptied" });
    },
    onError: onErrorToast("Couldn't empty Trash"),
  });

  const [zipBusy, setZipBusy] = useState(false);
  const downloadZip = useCallback(
    async (fileIds: string[]) => {
      setZipBusy(true);
      try {
        const res = await fetch(`${base}/zip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ fileIds }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `Download failed (${res.status})`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "files.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (err: any) {
        toast({
          title: "Couldn't download files",
          description: err?.message,
          variant: "destructive",
        });
      } finally {
        setZipBusy(false);
      }
    },
    [base, toast],
  );

  // ── Drag & drop ──────────────────────────────────────────────────────
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    if (trashMode) return;
    dragDepth.current += 1;
    if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (trashMode) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    // void: fire-and-forget from a sync DOM handler — the hook captures per-file failures into item state
    if (files.length > 0) void upload.uploadFiles(files, folderId);
  };
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // void: fire-and-forget from a sync DOM handler — the hook captures per-file failures into item state
    if (files.length > 0) void upload.uploadFiles(files, folderId);
    e.target.value = "";
  };

  // ── Derived rows ─────────────────────────────────────────────────────
  const files = useMemo(
    () => sortFiles(browse?.files ?? [], sort),
    [browse?.files, sort],
  );
  const folders = browse?.folders ?? [];
  const trashFiles = trash?.files ?? [];
  const searchRows = searchData?.files ?? [];
  const visibleFileIds = trashMode
    ? trashFiles.map((f) => f.id)
    : searching
      ? searchRows.map((f) => f.id)
      : files.map((f) => f.id);
  const allSelected =
    visibleFileIds.length > 0 && visibleFileIds.every((id) => selected.has(id));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(visibleFileIds));
  };
  const selectedIds = Array.from(selected).filter((id) =>
    visibleFileIds.includes(id),
  );

  const openFolder = (id: string | null) => {
    setFolderId(id);
    setSelected(new Set());
    setSearchInput("");
  };

  const fileByIdEverywhere = (id: string): FileRow | undefined =>
    files.find((f) => f.id === id) ??
    trashFiles.find((f) => f.id === id) ??
    searchRows.find((f) => f.id === id);

  // ── Row/card action menu ─────────────────────────────────────────────
  const fileMenu = (file: FileRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-primary-ink"
          aria-label={`Actions for ${file.name}`}
          data-testid={`button-file-menu-${file.id}`}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {!file.trashedAt ? (
          <>
            <DropdownMenuItem onClick={() => setPreviewFile(file)}>
              <Eye className="w-4 h-4 mr-2" /> Preview
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={downloadUrl(clientId, file.id)}>
                <Download className="w-4 h-4 mr-2" /> Download
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                setRenameTarget({ kind: "file", id: file.id, name: file.name });
                setRenameValue(file.name);
              }}
            >
              <Pencil className="w-4 h-4 mr-2" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                setMoveTarget({ kind: "files", ids: [file.id], label: file.name })
              }
            >
              <FolderInput className="w-4 h-4 mr-2" /> Move
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDetailsFileId(file.id)}>
              <Info className="w-4 h-4 mr-2" /> Details & versions
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => trashMutation.mutate([file.id])}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Move to Trash
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => restoreMutation.mutate([file.id])}>
              <RotateCcw className="w-4 h-4 mr-2" /> Restore
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDetailsFileId(file.id)}>
              <Info className="w-4 h-4 mr-2" /> Details
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => setPurgeIds([file.id])}
            >
              <Trash2 className="w-4 h-4 mr-2" /> Delete forever
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const fileNameCell = (file: FileRow, extra?: string | null) => (
    <button
      type="button"
      className="flex items-center gap-2 min-w-0 text-left group"
      onClick={() => (file.trashedAt ? setDetailsFileId(file.id) : setPreviewFile(file))}
      data-testid={`file-name-${file.id}`}
    >
      <FileKindIcon mimeType={file.mimeType} fileName={file.name} />
      <span className="truncate text-sm text-foreground group-hover:text-primary-ink group-hover:underline">
        {file.name}
      </span>
      {extra && (
        <span className="text-xs text-muted-foreground truncate shrink-0">{extra}</span>
      )}
    </button>
  );

  // ── Render ───────────────────────────────────────────────────────────
  const loading = trashMode ? trashLoading : searching ? searchLoading : browseLoading;

  return (
    <div
      className="relative"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-testid="client-files-tab"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPickFiles}
        data-testid="input-file-upload"
      />

      {dragActive && (
        <div className="absolute inset-0 z-40 bg-primary/10 border-2 border-dashed border-primary rounded-xl flex items-center justify-center pointer-events-none">
          <div className="bg-card rounded-lg shadow-lg px-6 py-4 flex items-center gap-2 text-foreground font-medium">
            <Upload className="w-5 h-5" />
            Drop files to upload
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search this client's files…"
            className="pl-8 h-9"
            data-testid="input-file-search"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
              data-testid="button-clear-search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-[130px] h-9" data-testid="select-file-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="size">Size</SelectItem>
            <SelectItem value="updated">Last updated</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex rounded-md border border-border overflow-hidden">
          <Button
            size="icon"
            variant="ghost"
            className={`h-9 w-9 rounded-none ${view === "list" ? "bg-primary/10 text-primary-ink" : "text-muted-foreground"}`}
            onClick={() => setView("list")}
            title="List view"
            data-testid="button-view-list"
          >
            <List className="w-4 h-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className={`h-9 w-9 rounded-none ${view === "grid" ? "bg-primary/10 text-primary-ink" : "text-muted-foreground"}`}
            onClick={() => setView("grid")}
            title="Grid view"
            data-testid="button-view-grid"
          >
            <LayoutGrid className="w-4 h-4" />
          </Button>
        </div>
        <Button
          variant={trashMode ? "default" : "outline"}
          className={`h-9 ${trashMode ? "bg-primary hover:bg-primary/90 text-primary-foreground" : ""}`}
          onClick={() => {
            setTrashMode((t) => !t);
            setSelected(new Set());
          }}
          data-testid="button-toggle-trash"
        >
          <Trash2 className="w-4 h-4 mr-1.5" />
          Trash
          {(usage?.trashCount ?? 0) > 0 && (
            <Badge
              variant="secondary"
              className={`ml-1.5 ${trashMode ? "bg-white/20 text-white" : ""}`}
            >
              {usage!.trashCount}
            </Badge>
          )}
        </Button>
        {!trashMode && (
          <>
            <Button
              variant="outline"
              className="h-9"
              onClick={() => setNewFolderOpen(true)}
              data-testid="button-new-folder"
            >
              <FolderPlus className="w-4 h-4 mr-1.5" />
              New folder
            </Button>
            <Button
              className="h-9 bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-upload"
            >
              <Upload className="w-4 h-4 mr-1.5" />
              Upload
            </Button>
          </>
        )}
      </div>

      {/* Breadcrumbs / mode header + usage */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        {trashMode ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-foreground flex items-center gap-1.5">
              <Trash2 className="w-4 h-4" /> Trash
            </span>
            <span className="text-muted-foreground">
              Files here can be restored or deleted forever.
            </span>
            {trashFiles.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => setEmptyTrashOpen(true)}
                data-testid="button-empty-trash"
              >
                Empty Trash
              </Button>
            )}
          </div>
        ) : searching ? (
          <p className="text-sm text-muted-foreground">
            {searchLoading
              ? "Searching…"
              : `${searchData?.total ?? 0} result${(searchData?.total ?? 0) === 1 ? "" : "s"} for “${searchQ}”`}
          </p>
        ) : (
          <nav className="flex items-center gap-1 text-sm min-w-0 flex-wrap" data-testid="file-breadcrumbs">
            <button
              type="button"
              onClick={() => openFolder(null)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-primary/5 ${folderId === null ? "text-primary-ink font-medium" : "text-muted-foreground"}`}
              data-testid="breadcrumb-root"
            >
              <Home className="w-3.5 h-3.5" /> Files
            </button>
            {(browse?.breadcrumbs ?? []).map((crumb, i, arr) => (
              <span key={crumb.id} className="flex items-center gap-1 min-w-0">
                <ChevronRight className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                <button
                  type="button"
                  onClick={() => openFolder(crumb.id)}
                  className={`px-1.5 py-0.5 rounded hover:bg-primary/5 truncate max-w-[180px] ${i === arr.length - 1 ? "text-primary-ink font-medium" : "text-muted-foreground"}`}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        {usage && (
          <p className="text-xs text-muted-foreground" data-testid="text-usage-summary">
            {usage.liveCount} file{usage.liveCount === 1 ? "" : "s"} ·{" "}
            {formatByteSize(usage.totalBytes)} used
          </p>
        )}
      </div>

      {/* Bulk actions bar */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-primary/5 border border-primary/15" data-testid="bulk-actions-bar">
          <span className="text-sm font-medium text-foreground">
            {selectedIds.length} selected
          </span>
          {!trashMode ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() =>
                  setMoveTarget({
                    kind: "files",
                    ids: selectedIds,
                    label: `${selectedIds.length} files`,
                  })
                }
                data-testid="button-bulk-move"
              >
                <FolderInput className="w-3.5 h-3.5 mr-1" /> Move
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={zipBusy}
                onClick={() => downloadZip(selectedIds)}
                data-testid="button-bulk-download"
              >
                {zipBusy ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5 mr-1" />
                )}
                Download
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-red-600 border-red-200 hover:bg-red-50"
                disabled={trashMutation.isPending}
                onClick={() => trashMutation.mutate(selectedIds)}
                data-testid="button-bulk-trash"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Trash
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={restoreMutation.isPending}
                onClick={() => restoreMutation.mutate(selectedIds)}
                data-testid="button-bulk-restore"
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1" /> Restore
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => setPurgeIds(selectedIds)}
                data-testid="button-bulk-purge"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete forever
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 ml-auto text-muted-foreground"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-primary/40" />
        </div>
      ) : trashMode ? (
        trashFiles.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Trash2 className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">Trash is empty.</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground text-left">
                  <th className="w-10 px-3 py-2">
                    <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} data-testid="checkbox-select-all" />
                  </th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium w-24">Size</th>
                  <th className="px-2 py-2 font-medium w-44">Trashed</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {trashFiles.map((file) => (
                  <tr key={file.id} className="border-b border-border/40 last:border-0 hover:bg-muted/60" data-testid={`trash-row-${file.id}`}>
                    <td className="px-3 py-2">
                      <Checkbox checked={selected.has(file.id)} onCheckedChange={() => toggleSelect(file.id)} />
                    </td>
                    <td className="px-2 py-2 max-w-0 w-full">{fileNameCell(file)}</td>
                    <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatByteSize(file.sizeBytes)}</td>
                    <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatWhen(file.trashedAt)}</td>
                    <td className="px-2 py-1">{fileMenu(file)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : searching ? (
        searchRows.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No files match “{searchQ}”.</p>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground text-left">
                  <th className="w-10 px-3 py-2">
                    <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} />
                  </th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 font-medium w-40">Folder</th>
                  <th className="px-2 py-2 font-medium w-24">Size</th>
                  <th className="w-12" />
                </tr>
              </thead>
              <tbody>
                {searchRows.map((file) => (
                  <tr key={file.id} className="border-b border-border/40 last:border-0 hover:bg-muted/60" data-testid={`search-row-${file.id}`}>
                    <td className="px-3 py-2">
                      <Checkbox checked={selected.has(file.id)} onCheckedChange={() => toggleSelect(file.id)} />
                    </td>
                    <td className="px-2 py-2 max-w-0 w-full">{fileNameCell(file)}</td>
                    <td className="px-2 py-2 text-muted-foreground truncate max-w-[160px]">
                      {file.trashedAt ? "Trash" : (file.folderName ?? "Files")}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatByteSize(file.sizeBytes)}</td>
                    <td className="px-2 py-1">{fileMenu(file)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : folders.length === 0 && files.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full text-center py-16 border-2 border-dashed border-border rounded-xl text-muted-foreground hover:border-primary/40 hover:text-primary-ink/70 transition-colors"
          data-testid="empty-drop-zone"
        >
          <Upload className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm font-medium">Drop files here or click to upload</p>
          <p className="text-xs mt-1">Files are stored securely in the app.</p>
        </button>
      ) : view === "grid" ? (
        <div>
          {folders.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2 mb-4">
              {folders.map((folder) => (
                <div
                  key={folder.id}
                  className="group flex items-center gap-2 border border-border rounded-lg px-3 py-2.5 bg-card hover:border-primary/30 hover:shadow-sm transition-all"
                  data-testid={`folder-card-${folder.id}`}
                >
                  <button
                    type="button"
                    className="flex items-center gap-2 min-w-0 flex-1 text-left"
                    onClick={() => openFolder(folder.id)}
                  >
                    <Folder className="w-5 h-5 text-primary/60 shrink-0" />
                    <span className="text-sm text-foreground truncate">{folder.name}</span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground" aria-label={`Actions for ${folder.name}`} data-testid={`button-folder-menu-${folder.id}`}>
                        <MoreHorizontal className="w-3.5 h-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenameTarget({ kind: "folder", id: folder.id, name: folder.name });
                          setRenameValue(folder.name);
                        }}
                      >
                        <Pencil className="w-4 h-4 mr-2" /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          setMoveTarget({ kind: "folder", ids: [folder.id], label: folder.name })
                        }
                      >
                        <FolderInput className="w-4 h-4 mr-2" /> Move
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-red-600 focus:text-red-600"
                        onClick={() => setDeleteFolderTarget(folder)}
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
            {files.map((file) => (
              <div
                key={file.id}
                className={`group relative border rounded-lg p-3 bg-card transition-all ${selected.has(file.id) ? "border-primary ring-1 ring-primary/30" : "border-border hover:border-primary/30 hover:shadow-sm"}`}
                data-testid={`file-card-${file.id}`}
              >
                <div className="absolute top-2 left-2 z-10">
                  <Checkbox
                    checked={selected.has(file.id)}
                    onCheckedChange={() => toggleSelect(file.id)}
                    className={`bg-card ${selected.has(file.id) ? "" : "opacity-0 group-hover:opacity-100"}`}
                  />
                </div>
                <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100">
                  {fileMenu(file)}
                </div>
                <button
                  type="button"
                  className="w-full text-center pt-4"
                  onClick={() => setPreviewFile(file)}
                >
                  <FileKindIcon mimeType={file.mimeType} fileName={file.name} className="w-9 h-9 mx-auto" />
                  <p className="mt-2 text-xs text-foreground break-words line-clamp-2" title={file.name}>
                    {file.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {formatByteSize(file.sizeBytes)}
                  </p>
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground text-left">
                <th className="w-10 px-3 py-2">
                  <Checkbox checked={allSelected} onCheckedChange={toggleSelectAll} data-testid="checkbox-select-all" />
                </th>
                <th className="px-2 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium w-24">Size</th>
                <th className="px-2 py-2 font-medium w-44">Modified</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr key={folder.id} className="border-b border-border/40 hover:bg-muted/60" data-testid={`folder-row-${folder.id}`}>
                  <td className="px-3 py-2" />
                  <td className="px-2 py-2 max-w-0 w-full">
                    <button
                      type="button"
                      className="flex items-center gap-2 min-w-0 text-left group"
                      onClick={() => openFolder(folder.id)}
                      data-testid={`folder-name-${folder.id}`}
                    >
                      <Folder className="w-4 h-4 text-primary/60 shrink-0" />
                      <span className="truncate text-foreground group-hover:text-primary-ink group-hover:underline">
                        {folder.name}
                      </span>
                    </button>
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">—</td>
                  <td className="px-2 py-2 text-muted-foreground">—</td>
                  <td className="px-2 py-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground hover:text-primary-ink" aria-label={`Actions for ${folder.name}`} data-testid={`button-folder-menu-${folder.id}`}>
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onClick={() => {
                            setRenameTarget({ kind: "folder", id: folder.id, name: folder.name });
                            setRenameValue(folder.name);
                          }}
                        >
                          <Pencil className="w-4 h-4 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            setMoveTarget({ kind: "folder", ids: [folder.id], label: folder.name })
                          }
                        >
                          <FolderInput className="w-4 h-4 mr-2" /> Move
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600"
                          onClick={() => setDeleteFolderTarget(folder)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
              {files.map((file) => (
                <tr key={file.id} className={`border-b border-border/40 last:border-0 hover:bg-muted/60 ${selected.has(file.id) ? "bg-primary/5" : ""}`} data-testid={`file-row-${file.id}`}>
                  <td className="px-3 py-2">
                    <Checkbox checked={selected.has(file.id)} onCheckedChange={() => toggleSelect(file.id)} data-testid={`checkbox-file-${file.id}`} />
                  </td>
                  <td className="px-2 py-2 max-w-0 w-full">{fileNameCell(file)}</td>
                  <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatByteSize(file.sizeBytes)}</td>
                  <td className="px-2 py-2 text-muted-foreground whitespace-nowrap">{formatWhen(file.contentUpdatedAt)}</td>
                  <td className="px-2 py-1">{fileMenu(file)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Upload progress panel */}
      {upload.items.length > 0 && (
        // FAB collider ref: the global comms button lifts above this panel on
        // mobile instead of covering its dismiss/expand controls (Task #4374).
        <div ref={fabColliderRef} className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] bg-card border border-border rounded-xl shadow-lg overflow-hidden" data-testid="upload-progress-panel">
          <div className="flex items-center justify-between px-3 py-2 bg-primary text-primary-foreground text-sm font-medium">
            <span>
              {upload.busy
                ? "Uploading…"
                : `Uploaded ${upload.items.filter((i) => i.status === "done").length} of ${upload.items.length}`}
            </span>
            {!upload.busy && (
              <button type="button" onClick={upload.clearSettled} className="text-white/80 hover:text-white" data-testid="button-close-upload-panel">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <ul className="max-h-56 overflow-y-auto divide-y divide-border">
            {upload.items.map((item) => (
              <li key={item.key} className="px-3 py-2" data-testid={`upload-item-${item.key}`}>
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-foreground">{item.fileName}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {item.status === "error" ? (
                      <span className="text-red-600">Failed</span>
                    ) : item.status === "done" ? (
                      "Done"
                    ) : item.status === "claiming" ? (
                      "Finishing…"
                    ) : (
                      `${item.progress}%`
                    )}
                  </span>
                </div>
                {(item.status === "uploading" || item.status === "claiming" || item.status === "queued") && (
                  <Progress value={item.progress} className="h-1 mt-1.5" />
                )}
                {item.status === "error" && item.error && (
                  <p className="text-caption text-red-500 dark:text-red-400 mt-0.5 break-words">{item.error}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* New folder dialog */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-new-folder">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Create a folder{browse?.breadcrumbs?.length ? ` inside “${browse.breadcrumbs[browse.breadcrumbs.length - 1].name}”` : ""}.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = sanitizeClientFileName(newFolderName);
              if (name) createFolder.mutate(name);
            }}
          >
            <Input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              data-testid="input-new-folder-name"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setNewFolderOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!sanitizeClientFileName(newFolderName) || createFolder.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="button-create-folder"
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm" data-testid="dialog-rename">
          <DialogHeader>
            <DialogTitle>Rename {renameTarget?.kind === "folder" ? "folder" : "file"}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = sanitizeClientFileName(renameValue);
              if (renameTarget && name && name !== renameTarget.name) {
                renameMutation.mutate({ kind: renameTarget.kind, id: renameTarget.id, name });
              } else {
                setRenameTarget(null);
              }
            }}
          >
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              data-testid="input-rename"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!sanitizeClientFileName(renameValue) || renameMutation.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="button-rename-confirm"
              >
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Move dialog */}
      {moveTarget && (
        <MoveFolderDialog
          title={`Move ${moveTarget.label}`}
          description="Choose a destination folder."
          folders={tree?.folders ?? []}
          excludeSubtreeOf={moveTarget.kind === "folder" ? moveTarget.ids[0] : undefined}
          currentFolderId={folderId}
          busy={moveMutation.isPending}
          onMove={(destination) => moveMutation.mutate({ target: moveTarget, destination })}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {/* Delete folder confirm */}
      <AlertDialog open={!!deleteFolderTarget} onOpenChange={(open) => !open && setDeleteFolderTarget(null)}>
        <AlertDialogContent data-testid="dialog-delete-folder">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteFolderTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The folder and its subfolders will be removed. Files inside are
              moved to Trash, where they can be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteFolderTarget && deleteFolderMutation.mutate(deleteFolderTarget.id)}
              data-testid="button-delete-folder-confirm"
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Purge confirm */}
      <AlertDialog open={!!purgeIds} onOpenChange={(open) => !open && setPurgeIds(null)}>
        <AlertDialogContent data-testid="dialog-purge">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete {purgeIds?.length === 1 ? "this file" : `${purgeIds?.length ?? 0} files`}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This also deletes all prior versions. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => purgeIds && purgeMutation.mutate(purgeIds)}
              data-testid="button-purge-confirm"
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Documents (NoBull Docs) — editable in-app word documents for this client */}
      {!trashMode && (
        <DocumentsSection
          clientId={clientId}
          subtitle="Word documents for this client — edited in-app"
        />
      )}

      {/* Empty trash confirm */}
      <AlertDialog open={emptyTrashOpen} onOpenChange={setEmptyTrashOpen}>
        <AlertDialogContent data-testid="dialog-empty-trash">
          <AlertDialogHeader>
            <AlertDialogTitle>Empty Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              All {trashFiles.length} trashed file{trashFiles.length === 1 ? "" : "s"} and
              their versions will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={emptyTrashMutation.isPending}
              onClick={() => emptyTrashMutation.mutate()}
              data-testid="button-empty-trash-confirm"
            >
              Empty Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Preview + details */}
      <FilePreviewDialog
        clientId={clientId}
        file={previewFile}
        onClose={() => setPreviewFile(null)}
      />
      <FileDetailsSheet
        clientId={clientId}
        fileId={detailsFileId}
        onClose={() => setDetailsFileId(null)}
      />
    </div>
  );
}

export default ClientFilesTab;
