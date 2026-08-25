/**
 * SheetsLibrary — workbook library with folders, search, CRUD, duplication,
 * save-as-template, template gallery, and template management.
 *
 * - Fetches /api/sheets/folders, /api/sheets/workbooks, /api/sheets/templates.
 * - Groups workbooks by folder; unfiled workbooks appear in an "Unfiled" section.
 * - Create workbook (blank or from template), create folder dialogs.
 * - Duplicate workbook, save as template (owner-only).
 * - Template management section (CEO-only): rename, archive, delete templates.
 * - Search/filter by workbook name (client-side, debounced).
 * - Matches the Beige & Burgundy design system; responsive at 375/768/1024+.
 */

import {
  useState,
  useCallback,
  useRef,
  type FormEvent,
  type DragEvent,
} from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import DocumentsSection from "@/components/docs/DocumentsSection";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  Plus,
  FolderPlus,
  Search,
  Loader2,
  FileSpreadsheet,
  Folder,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderInput,
  Copy,
  LayoutTemplate,
  Archive,
  RefreshCw,
  Upload,
  CheckCircle2,
  AlertTriangle,
  Sheet,
  Info,
  Share2,
  Download,
  LayoutDashboard,
  ExternalLink,
  Globe,
} from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { ShareDialog } from "@/components/sheets/ShareDialog";
import { EmptyState } from "@/components/kit/EmptyState";
import {
  OsTable,
  type OsTableColumn,
  type OsTableSort,
} from "@/components/ui/os-table";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ImportSkippedItem {
  kind: string;
  detail: string;
}

interface ImportReport {
  sheetCount: number;
  cellCount: number;
  formulaCount: number;
  mergeCount: number;
  skipped: ImportSkippedItem[];
}

interface SheetFolder {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

interface SheetWorkbook {
  id: string;
  name: string;
  ownerId: string;
  folderId: string | null;
  updatedAt: string;
}

interface SheetTemplate {
  id: string;
  name: string;
  description: string | null;
  createdByUserId: string;
  sourceWorkbookId: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}


// ── Workbook actions menu (Actions column of the library table) ──────────────
// Task #4371 (audit P2-7 §7.3): the card grid + per-folder duplication is
// consolidated into ONE OsTable; this menu is the former card's dropdown,
// unchanged item-for-item (testids preserved), rendered per row.

interface WorkbookActionsMenuProps {
  workbook: SheetWorkbook;
  hasFolders: boolean;
  isOwner: boolean;
  isCeo: boolean;
  isPublished?: boolean;
  onRename: (wb: SheetWorkbook) => void;
  onMove: (wb: SheetWorkbook) => void;
  onDelete: (wb: SheetWorkbook) => void;
  onDuplicate: (wb: SheetWorkbook) => void;
  onSaveAsTemplate: (wb: SheetWorkbook) => void;
  onShare: (wb: SheetWorkbook) => void;
  onDownloadXlsx: (wb: SheetWorkbook) => void;
  onPublishAsDashboard: (wb: SheetWorkbook) => void;
}

function WorkbookActionsMenu({
  workbook,
  hasFolders,
  isOwner,
  isCeo,
  isPublished,
  onRename,
  onMove,
  onDelete,
  onDuplicate,
  onSaveAsTemplate,
  onShare,
  onDownloadXlsx,
  onPublishAsDashboard,
}: WorkbookActionsMenuProps) {
  const canEdit = isOwner;
  const canTemplate = isOwner || isCeo;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          data-testid={`btn-workbook-menu-${workbook.id}`}
          aria-label={`Actions for ${workbook.name}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onClick={(e) => e.stopPropagation()}
      >
            {canEdit && (
              <>
                <DropdownMenuItem
                  onClick={() => onRename(workbook)}
                  data-testid={`menu-rename-workbook-${workbook.id}`}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename
                </DropdownMenuItem>
                {hasFolders && (
                  <DropdownMenuItem
                    onClick={() => onMove(workbook)}
                    data-testid={`menu-move-workbook-${workbook.id}`}
                  >
                    <FolderInput className="mr-2 h-4 w-4" />
                    Move to folder
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => onDuplicate(workbook)}
                  data-testid={`menu-duplicate-workbook-${workbook.id}`}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>
                {canTemplate && (
                  <DropdownMenuItem
                    onClick={() => onSaveAsTemplate(workbook)}
                    data-testid={`menu-save-as-template-${workbook.id}`}
                  >
                    <LayoutTemplate className="mr-2 h-4 w-4" />
                    Save as Template
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => onPublishAsDashboard(workbook)}
                  data-testid={`menu-publish-dashboard-${workbook.id}`}
                >
                  <LayoutDashboard className="mr-2 h-4 w-4" />
                  {isPublished ? "Update Dashboard" : "Publish as Dashboard"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onShare(workbook)}
                  data-testid={`menu-share-workbook-${workbook.id}`}
                >
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(workbook)}
                  className="text-destructive focus:text-destructive"
                  data-testid={`menu-delete-workbook-${workbook.id}`}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem
              onClick={() => onDownloadXlsx(workbook)}
              data-testid={`menu-download-xlsx-${workbook.id}`}
            >
              <Download className="mr-2 h-4 w-4" />
              Download as Excel
            </DropdownMenuItem>
            {!canEdit && (
              <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                Shared with you — view only
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Template card (gallery) ───────────────────────────────────────────────────

interface TemplateCardProps {
  template: SheetTemplate;
  onUse: (t: SheetTemplate) => void;
}

function TemplateCard({ template, onUse }: TemplateCardProps) {
  return (
    <button
      type="button"
      className="text-left flex flex-col gap-1.5 rounded-lg border border-[#E8DED5] bg-card p-4 shadow-sm hover:border-primary/40 hover:shadow-md transition-all"
      data-testid={`card-template-${template.id}`}
      onClick={() => onUse(template)}
    >
      <div className="flex items-center gap-2">
        <LayoutTemplate className="h-4 w-4 shrink-0 text-primary" />
        <span className="text-sm font-medium text-foreground truncate">
          {template.name}
        </span>
      </div>
      {template.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {template.description}
        </p>
      )}
    </button>
  );
}
interface PublishedDashboard {
  id: string;
  workbookId: string;
  title: string;
  publishedBy: string;
  publishedAt: string;
  tabs: { sheetId: string; sheetName: string }[];
  audienceUserIds: string[];
  audienceRoles: string[];
  updatedAt: string;
  workbookName: string;
}

type DialogState =
  | { kind: "none" }
  | { kind: "create-workbook" }
  | { kind: "create-folder" }
  | { kind: "rename-workbook"; workbook: SheetWorkbook }
  | { kind: "rename-folder"; folder: SheetFolder }
  | { kind: "move-workbook"; workbook: SheetWorkbook }
  | { kind: "delete-workbook"; workbook: SheetWorkbook }
  | { kind: "delete-folder"; folder: SheetFolder }
  | { kind: "duplicate-workbook"; workbook: SheetWorkbook }
  | { kind: "save-as-template"; workbook: SheetWorkbook }
  | { kind: "create-from-template"; template: SheetTemplate }
  | { kind: "rename-template"; template: SheetTemplate }
  | { kind: "update-template"; template: SheetTemplate }
  | { kind: "archive-template"; template: SheetTemplate }
  | { kind: "delete-template"; template: SheetTemplate }
  | { kind: "import" }
  | { kind: "import-summary"; report: ImportReport; workbookId: string; workbookName: string }
  | { kind: "share-workbook"; workbook: SheetWorkbook }
  | { kind: "publish-dashboard"; workbook: SheetWorkbook }
  | { kind: "unpublish-dashboard"; dashboard: PublishedDashboard };

export default function SheetsLibrary() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchRaw, setSearchRaw] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [createMode, setCreateMode] = useState<"blank" | "template">("blank");

  // ── Library table state (Task #4371 — one OsTable, client-paginated) ──────
  // "all" | "unfiled" | <folderId>. Replaces the per-folder card sections.
  const [folderFilter, setFolderFilter] = useState<string>("all");
  const [wbSort, setWbSort] = useState<OsTableSort | null>({
    key: "updated",
    direction: "desc",
  });
  const [wbPage, setWbPage] = useState(1);
  const [wbPageSize, setWbPageSize] = useState(25);

  // ── Controlled field state shared across dialogs ───────────────────────────
  const [nameField, setNameField] = useState("");
  const [descField, setDescField] = useState("");
  const [folderField, setFolderField] = useState<string>("none");

  // ── Publish-as-Dashboard dialog state ─────────────────────────────────────
  const [dashTitle, setDashTitle] = useState("");
  const [dashSelectedTabIds, setDashSelectedTabIds] = useState<Set<string>>(new Set());
  const [dashRoles, setDashRoles] = useState<Set<string>>(new Set());
  const AVAILABLE_ROLES = ["ceo", "admin", "account_manager", "reporting"] as const;

  // ── Import state ───────────────────────────────────────────────────────────
  const [isDragOver, setIsDragOver] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Drive picker state ─────────────────────────────────────────────────────

  const searchTerm = searchRaw.trim().toLowerCase();

  const isCeo = user?.role === "ceo";
  const isOwnerOrCeo = isCeo || user?.role === "admin";

  // ── Queries ────────────────────────────────────────────────────────────────
  const foldersQuery = useQuery<{ folders: SheetFolder[] }>({
    queryKey: ["/api/sheets/folders"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const templatesQuery = useQuery<{ templates: SheetTemplate[] }>({
    queryKey: ["/api/sheets/templates"],
    queryFn: getQueryFn({ on401: "throw" }),
  });


  const dashboardsQuery = useQuery<{ dashboards: PublishedDashboard[] }>({
    queryKey: ["/api/sheets/dashboards"],
    queryFn: getQueryFn({ on401: "throw" }),
    staleTime: 30_000,
  });

  // Fetch tabs for the workbook being published (dialog only).
  const publishDialogWorkbookId =
    dialog.kind === "publish-dashboard" ? dialog.workbook.id : null;
  const tabsQuery = useQuery<{ tabs: { sheetId: string; sheetName: string }[] }>({
    queryKey: [`/api/sheets/workbooks/${publishDialogWorkbookId}/tabs`],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/sheets/workbooks/${publishDialogWorkbookId}/tabs`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    enabled: !!publishDialogWorkbookId,
    staleTime: 60_000,
  });

  const folders = foldersQuery.data?.folders ?? [];

  // ── Workbooks list — server mode (Task #4488) ─────────────────────────────
  // Search, folder filter, sort AND pagination all run server-side; the
  // browser only downloads the current page plus a `total` for the pager.
  const folderNameById = new Map(folders.map((f) => [f.id, f.name]));
  // Self-healing: a deleted folder that is still selected falls back to "all".
  const effectiveFolderFilter =
    folderFilter === "all" ||
    folderFilter === "unfiled" ||
    folderNameById.has(folderFilter)
      ? folderFilter
      : "all";
  const debouncedSearch = useDebounce(searchTerm, 250);

  const workbooksUrl = (() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (effectiveFolderFilter === "unfiled") params.set("folderId", "null");
    else if (effectiveFolderFilter !== "all")
      params.set("folderId", effectiveFolderFilter);
    if (wbSort) {
      params.set("sort", wbSort.key);
      params.set("dir", wbSort.direction);
    }
    params.set("limit", String(wbPageSize));
    params.set("offset", String((wbPage - 1) * wbPageSize));
    return `/api/sheets/workbooks?${params.toString()}`;
  })();

  const workbooksQuery = useQuery<{ workbooks: SheetWorkbook[]; total?: number }>({
    queryKey: [workbooksUrl],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const allWorkbooks = workbooksQuery.data?.workbooks ?? [];
  const wbTotal = workbooksQuery.data?.total ?? allWorkbooks.length;
  const allTemplates = (templatesQuery.data?.templates ?? []).filter(
    (t) => !t.isArchived
  );
  const archivedTemplates = (templatesQuery.data?.templates ?? []).filter(
    (t) => t.isArchived
  );

  const publishedDashboards = dashboardsQuery.data?.dashboards ?? [];
  const publishedWorkbookIds = new Set(publishedDashboards.map((d) => d.workbookId));

  // ── Last-activity map ──────────────────────────────────────────────────────
  const workbookIds = allWorkbooks.map((wb) => wb.id);
  const lastActivityQuery = useQuery<{ lastActivity: Record<string, string> }>({
    queryKey: ["/api/sheets/workbooks/last-activity", workbookIds.join(",")],
    queryFn: async () => {
      if (workbookIds.length === 0) return { lastActivity: {} };
      const res = await apiRequest(
        "GET",
        `/api/sheets/workbooks/last-activity?ids=${encodeURIComponent(workbookIds.join(","))}`,
      );
      return res.json();
    },
    enabled: workbookIds.length > 0,
    staleTime: 60_000,
    // Decorative column: a failure here must never fire the global
    // "Request failed" toast (Task #4303) — the cards simply hide their
    // "Activity <date>" line when the map is absent.
    meta: { silent: true },
  });
  const lastActivityMap: Record<string, string> = lastActivityQuery.data?.lastActivity ?? {};

  // ── Mutations ──────────────────────────────────────────────────────────────
  const invalidateLists = useCallback(() => {
    // Paged workbook keys carry query params — prefix-match by URL string
    // (also refreshes /last-activity and per-workbook subresources).
    void queryClient.invalidateQueries({
      predicate: (query) =>
        String(query.queryKey[0]).startsWith("/api/sheets/workbooks"),
    }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/sheets/folders"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/sheets/dashboards"] }); // fire-and-forget: cache refresh only
  }, [queryClient]);

  const invalidateTemplates = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["/api/sheets/templates"] }); // fire-and-forget: cache refresh only
  }, [queryClient]);

  const createWorkbookMut = useMutation({
    mutationFn: async (data: { name: string; folderId?: string | null }) => {
      const res = await apiRequest("POST", "/api/sheets/workbooks", data);
      return res.json();
    },
    onSuccess: (data) => {
      invalidateLists();
      closeDialog();
      setLocation(`/sheets/${data.workbook.id}`);
    },
    onError: (err: any) => {
      toast({ title: "Could not create workbook", description: err?.message, variant: "destructive" });
    },
  });

  const createFolderMut = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/sheets/folders", { name });
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not create folder", description: err?.message, variant: "destructive" });
    },
  });

  const renameWorkbookMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/sheets/workbooks/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not rename workbook", description: err?.message, variant: "destructive" });
    },
  });

  const renameFolderMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/sheets/folders/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not rename folder", description: err?.message, variant: "destructive" });
    },
  });

  const moveWorkbookMut = useMutation({
    mutationFn: async ({ id, folderId }: { id: string; folderId: string | null }) => {
      const res = await apiRequest("PATCH", `/api/sheets/workbooks/${id}`, { folderId });
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not move workbook", description: err?.message, variant: "destructive" });
    },
  });

  const deleteWorkbookMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/workbooks/${id}`);
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not delete workbook", description: err?.message, variant: "destructive" });
    },
  });

  const deleteFolderMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/folders/${id}`);
      return res.json();
    },
    onSuccess: () => {
      invalidateLists();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not delete folder", description: err?.message, variant: "destructive" });
    },
  });

  const duplicateWorkbookMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${id}/duplicate`, { name });
      return res.json();
    },
    onSuccess: (data) => {
      invalidateLists();
      closeDialog();
      setLocation(`/sheets/${data.workbook.id}`);
    },
    onError: (err: any) => {
      toast({ title: "Could not duplicate workbook", description: err?.message, variant: "destructive" });
    },
  });

  const saveAsTemplateMut = useMutation({
    mutationFn: async ({ id, name, description }: { id: string; name: string; description?: string }) => {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${id}/save-as-template`, { name, description });
      return res.json();
    },
    onSuccess: () => {
      invalidateTemplates();
      closeDialog();
      toast({ title: "Template saved", description: "This workbook has been saved as a template." });
    },
    onError: (err: any) => {
      toast({ title: "Could not save template", description: err?.message, variant: "destructive" });
    },
  });

  const createFromTemplateMut = useMutation({
    mutationFn: async ({ templateId, name, folderId }: { templateId: string; name: string; folderId?: string | null }) => {
      const res = await apiRequest("POST", `/api/sheets/templates/${templateId}/workbook`, { name, folderId });
      return res.json();
    },
    onSuccess: (data) => {
      invalidateLists();
      closeDialog();
      setLocation(`/sheets/${data.workbook.id}`);
    },
    onError: (err: any) => {
      toast({ title: "Could not create workbook", description: err?.message, variant: "destructive" });
    },
  });

  const renameTemplateMut = useMutation({
    mutationFn: async ({ id, name, description }: { id: string; name: string; description?: string }) => {
      const res = await apiRequest("PATCH", `/api/sheets/templates/${id}`, { name, description });
      return res.json();
    },
    onSuccess: () => {
      invalidateTemplates();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not update template", description: err?.message, variant: "destructive" });
    },
  });

  const archiveTemplateMut = useMutation({
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) => {
      const res = await apiRequest("PATCH", `/api/sheets/templates/${id}`, { isArchived: archived });
      return res.json();
    },
    onSuccess: (_, vars) => {
      invalidateTemplates();
      closeDialog();
      toast({ title: vars.archived ? "Template archived" : "Template restored" });
    },
    onError: (err: any) => {
      toast({ title: "Could not update template", description: err?.message, variant: "destructive" });
    },
  });

  const deleteTemplateMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/templates/${id}`);
      return res.json();
    },
    onSuccess: () => {
      invalidateTemplates();
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: "Could not delete template", description: err?.message, variant: "destructive" });
    },
  });

  const publishDashboardMut = useMutation({
    mutationFn: async (vars: {
      workbookId: string;
      title: string;
      tabs: { sheetId: string; sheetName: string }[];
      audienceRoles: string[];
    }) => {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${vars.workbookId}/dashboard`, {
        title: vars.title,
        tabs: vars.tabs,
        audienceUserIds: [],
        audienceRoles: vars.audienceRoles,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/sheets/dashboards"] }); // fire-and-forget: cache refresh only
      closeDialog();
      toast({ title: "Dashboard published", description: "The dashboard is now visible to your audience." });
    },
    onError: (err: any) => {
      toast({ title: "Could not publish dashboard", description: err?.message, variant: "destructive" });
    },
  });

  const unpublishDashboardMut = useMutation({
    mutationFn: async (workbookId: string) => {
      const res = await apiRequest("DELETE", `/api/sheets/workbooks/${workbookId}/dashboard`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      return data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/sheets/dashboards"] }); // fire-and-forget: cache refresh only
      closeDialog();
      toast({ title: "Dashboard unpublished" });
    },
    onError: (err: any) => {
      toast({ title: "Could not unpublish dashboard", description: err?.message, variant: "destructive" });
    },
  });

  // ── Import handler ─────────────────────────────────────────────────────────

  const handleImportFile = useCallback(async (file: File) => {
    const ALLOWED = /\.(xlsx|xls|csv|tsv)$/i;
    if (!ALLOWED.test(file.name)) {
      toast({
        title: "Unsupported file type",
        description: "Please select an .xlsx, .xls, or .csv file.",
        variant: "destructive",
      });
      return;
    }
    const MAX_MB = 50;
    if (file.size > MAX_MB * 1024 * 1024) {
      toast({
        title: "File too large",
        description: `The file must be under ${MAX_MB} MB.`,
        variant: "destructive",
      });
      return;
    }

    setIsImporting(true);
    closeDialog();

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch("/api/sheets/workbooks/import", {
        method: "POST",
        body: form,
        credentials: "include",
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(
          data?.message ?? data?.error ?? `Upload failed (${res.status})`,
        );
      }

      invalidateLists();
      setDialog({
        kind: "import-summary",
        report: data.report,
        workbookId: data.workbook.id,
        workbookName: data.workbook.name,
      });
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err?.message ?? "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [invalidateLists, toast]);

  // ── Dialog helpers ─────────────────────────────────────────────────────────
  function openCreateWorkbook(mode: "blank" | "template" = "blank") {
    setNameField("");
    setFolderField("none");
    setCreateMode(mode);
    setDialog({ kind: "create-workbook" });
  }

  function openCreateFolder() {
    setNameField("");
    setDialog({ kind: "create-folder" });
  }

  function openRenameWorkbook(wb: SheetWorkbook) {
    setNameField(wb.name);
    setDialog({ kind: "rename-workbook", workbook: wb });
  }

  function openRenameFolder(f: SheetFolder) {
    setNameField(f.name);
    setDialog({ kind: "rename-folder", folder: f });
  }

  function openMoveWorkbook(wb: SheetWorkbook) {
    setFolderField(wb.folderId ?? "none");
    setDialog({ kind: "move-workbook", workbook: wb });
  }

  function openDeleteWorkbook(wb: SheetWorkbook) {
    setDialog({ kind: "delete-workbook", workbook: wb });
  }

  function openDeleteFolder(f: SheetFolder) {
    setDialog({ kind: "delete-folder", folder: f });
  }

  function openDuplicateWorkbook(wb: SheetWorkbook) {
    setNameField(`${wb.name} (copy)`);
    setDialog({ kind: "duplicate-workbook", workbook: wb });
  }

  function openSaveAsTemplate(wb: SheetWorkbook) {
    setNameField(wb.name);
    setDescField("");
    setDialog({ kind: "save-as-template", workbook: wb });
  }

  function openCreateFromTemplate(t: SheetTemplate) {
    setNameField(t.name);
    setFolderField("none");
    setDialog({ kind: "create-from-template", template: t });
  }

  function openRenameTemplate(t: SheetTemplate) {
    setNameField(t.name);
    setDescField(t.description ?? "");
    setDialog({ kind: "rename-template", template: t });
  }

  function openArchiveTemplate(t: SheetTemplate) {
    setDialog({ kind: "archive-template", template: t });
  }

  function openDeleteTemplate(t: SheetTemplate) {
    setDialog({ kind: "delete-template", template: t });
  }

  function openShareWorkbook(wb: SheetWorkbook) {
    setDialog({ kind: "share-workbook", workbook: wb });
  }

  function openPublishAsDashboard(wb: SheetWorkbook) {
    // Pre-fill title from workbook name; tabs/roles reset each time.
    setDashTitle(wb.name);
    setDashSelectedTabIds(new Set());
    setDashRoles(new Set());
    setDialog({ kind: "publish-dashboard", workbook: wb });
  }

  function closeDialog() {
    setDialog({ kind: "none" });
  }

  // ── Submit handlers ────────────────────────────────────────────────────────
  function handleCreateWorkbook(e: FormEvent) {
    e.preventDefault();
    const trimmed = nameField.trim();
    if (!trimmed) return;
    createWorkbookMut.mutate({
      name: trimmed,
      folderId: folderField === "none" ? null : folderField,
    });
  }

  function handleCreateFolder(e: FormEvent) {
    e.preventDefault();
    const trimmed = nameField.trim();
    if (!trimmed) return;
    createFolderMut.mutate(trimmed);
  }

  function handleRenameWorkbook(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "rename-workbook") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    renameWorkbookMut.mutate({ id: dialog.workbook.id, name: trimmed });
  }

  function handleRenameFolder(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "rename-folder") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    renameFolderMut.mutate({ id: dialog.folder.id, name: trimmed });
  }

  function handleMoveWorkbook(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "move-workbook") return;
    moveWorkbookMut.mutate({
      id: dialog.workbook.id,
      folderId: folderField === "none" ? null : folderField,
    });
  }

  function handleDuplicate(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "duplicate-workbook") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    duplicateWorkbookMut.mutate({ id: dialog.workbook.id, name: trimmed });
  }

  function handleSaveAsTemplate(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "save-as-template") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    saveAsTemplateMut.mutate({
      id: dialog.workbook.id,
      name: trimmed,
      description: descField.trim() || undefined,
    });
  }

  function handleCreateFromTemplate(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "create-from-template") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    createFromTemplateMut.mutate({
      templateId: dialog.template.id,
      name: trimmed,
      folderId: folderField === "none" ? null : folderField,
    });
  }

  function handleRenameTemplate(e: FormEvent) {
    e.preventDefault();
    if (dialog.kind !== "rename-template") return;
    const trimmed = nameField.trim();
    if (!trimmed) return;
    renameTemplateMut.mutate({
      id: dialog.template.id,
      name: trimmed,
      description: descField.trim() || undefined,
    });
  }

  // ── Navigate into editor ───────────────────────────────────────────────────
  function openWorkbook(wb: SheetWorkbook) {
    setLocation(`/sheets/${wb.id}`);
  }

  // ── Download as Excel ──────────────────────────────────────────────────────
  function handleDownloadXlsx(wb: SheetWorkbook) {
    const a = document.createElement("a");
    a.href = `/api/sheets/workbooks/${wb.id}/export/xlsx`;
    a.download = `${wb.name}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ── Table rows: sort (controlled) then page (client-side) ─────────────────
  const isLoading = foldersQuery.isLoading || workbooksQuery.isLoading;
  const isError = foldersQuery.isError || workbooksQuery.isError;
  // Empty library (no rows AND no active narrowing) shows the create CTA;
  // a narrowed empty page falls through to the table's emptyState.
  const isEmpty =
    !isLoading &&
    wbTotal === 0 &&
    !searchTerm &&
    effectiveFolderFilter === "all";

  const currentUserId = user?.id ?? "";

  // Server mode (Task #4488): rows arrive pre-filtered, pre-sorted and
  // pre-sliced; `wbTotal` (declared with the query above) drives the pager.
  const wbPageCount = Math.max(1, Math.ceil(wbTotal / wbPageSize));
  const wbSafePage = Math.min(wbPage, wbPageCount);
  const pagedWorkbooks = allWorkbooks;

  if (!user) return null;

  const selectedFolder =
    effectiveFolderFilter !== "all" && effectiveFolderFilter !== "unfiled"
      ? (folders.find((f) => f.id === effectiveFolderFilter) ?? null)
      : null;

  // Plain const below the early returns (never a `<OsTable<Row>>` JSX
  // generic — dev babel chokes on those in client files).
  const workbookColumns: Array<OsTableColumn<SheetWorkbook>> = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (wb) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileSpreadsheet
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span
            className="truncate text-sm font-medium text-foreground"
            data-testid={`text-workbook-name-${wb.id}`}
          >
            {wb.name}
          </span>
        </div>
      ),
    },
    {
      key: "folder",
      header: "Folder",
      sortable: true,
      width: 160,
      cell: (wb) => (
        <span className="text-sm text-muted-foreground">
          {(wb.folderId ? folderNameById.get(wb.folderId) : null) ?? "Unfiled"}
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      sortable: true,
      width: 100,
      cell: (wb) => (
        <span
          className="text-sm text-muted-foreground"
          data-testid={`text-workbook-owner-${wb.id}`}
        >
          {wb.ownerId === currentUserId ? "You" : "Shared"}
        </span>
      ),
    },
    {
      key: "updated",
      header: "Edited",
      sortable: true,
      width: 120,
      cell: (wb) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {formatDate(wb.updatedAt)}
        </span>
      ),
    },
    {
      key: "activity",
      header: "Activity",
      sortable: true,
      width: 120,
      cell: (wb) =>
        lastActivityMap[wb.id] ? (
          <span
            className="whitespace-nowrap text-sm text-muted-foreground"
            data-testid={`text-workbook-last-activity-${wb.id}`}
          >
            {formatDate(lastActivityMap[wb.id])}
          </span>
        ) : (
          <span className="text-sm text-gray-300">—</span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 64,
      cell: (wb) => (
        <WorkbookActionsMenu
          workbook={wb}
          hasFolders={folders.length > 0}
          isOwner={wb.ownerId === currentUserId}
          isCeo={isCeo}
          isPublished={publishedWorkbookIds.has(wb.id)}
          onRename={openRenameWorkbook}
          onMove={openMoveWorkbook}
          onDelete={openDeleteWorkbook}
          onDuplicate={openDuplicateWorkbook}
          onSaveAsTemplate={openSaveAsTemplate}
          onShare={openShareWorkbook}
          onDownloadXlsx={handleDownloadXlsx}
          onPublishAsDashboard={openPublishAsDashboard}
        />
      ),
    },
  ];

  return (
    <div
      className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2"
      data-testid="sheets-library-root"
    >
      <div className="container mx-auto px-4 py-8 max-w-7xl">
        {/* ── Page header ──────────────────────────────────────────────────── */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Sheets</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Workbooks shared with you and your team
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Hidden file input for import */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv"
              className="sr-only"
              aria-label="Import workbook file"
              data-testid="input-import-file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file); // fire-and-forget: errors handled inside handleImportFile
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={openCreateFolder}
              data-testid="btn-create-folder"
            >
              <FolderPlus className="mr-1.5 h-4 w-4" />
              New Folder
            </Button>
            {allTemplates.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openCreateWorkbook("template")}
                data-testid="btn-create-from-template"
              >
                <LayoutTemplate className="mr-1.5 h-4 w-4" />
                From Template
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={isImporting}
              onClick={() => setDialog({ kind: "import" })}
              data-testid="btn-import-workbook"
            >
              {isImporting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-1.5 h-4 w-4" />
              )}
              {isImporting ? "Importing…" : "Import"}
            </Button>
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => openCreateWorkbook("blank")}
              data-testid="btn-create-workbook"
            >
              <Plus className="mr-1.5 h-4 w-4" />
              New Workbook
            </Button>
          </div>
        </div>

        {/* ── Search ───────────────────────────────────────────────────────── */}
        <div className="mb-6 relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-9"
            placeholder="Search workbooks…"
            aria-label="Search workbooks"
            value={searchRaw}
            onChange={(e) => {
              setSearchRaw(e.target.value);
              setWbPage(1);
            }}
            data-testid="input-search-workbooks"
          />
        </div>

        {/* ── Body ─────────────────────────────────────────────────────────── */}
        {isLoading ? (
          <div
            className="flex items-center justify-center py-24"
            data-testid="sheets-loading"
          >
            <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
          </div>
        ) : isError ? (
          <div
            className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-8 text-center"
            data-testid="sheets-error"
            role="status"
          >
            <p className="text-sm text-destructive">
              Couldn't load your workbooks. Retry.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void foldersQuery.refetch();
                void workbooksQuery.refetch();
              }}
              data-testid="button-retry-workbooks"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : isEmpty ? (
          /* Empty state */
          <EmptyState
            testId="sheets-empty-state"
            icon={<FileSpreadsheet />}
            title="No workbooks yet"
            description="Create your first workbook to get started."
            action={
              <>
                {allTemplates.length > 0 && (
                  <Button
                    variant="outline"
                    onClick={() => openCreateWorkbook("template")}
                    data-testid="btn-empty-create-from-template"
                  >
                    <LayoutTemplate className="mr-1.5 h-4 w-4" />
                    From Template
                  </Button>
                )}
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  onClick={() => openCreateWorkbook("blank")}
                  data-testid="btn-empty-create-workbook"
                >
                  <Plus className="mr-1.5 h-4 w-4" />
                  New Workbook
                </Button>
              </>
            }
          />
        ) : (
          /* One bounded workbook table (Task #4371, audit P2-7 §7.3): search
             results and folder browsing share this single presentation —
             the folder filter in the toolbar replaces the per-folder card
             sections, and the pager bounds rendering at any library size. */
          <div className="space-y-3" data-testid="workbooks-table-section">
            {searchTerm && (
              <p className="text-sm text-muted-foreground" data-testid="search-results-count">
                {wbTotal === 0
                  ? "No workbooks match your search."
                  : `${wbTotal} workbook${wbTotal === 1 ? "" : "s"} found`}
              </p>
            )}
            <OsTable
              data-testid="sheets-workbooks-table"
              rows={pagedWorkbooks}
              rowKey={(wb) => wb.id}
              columns={workbookColumns}
              sort={wbSort}
              onSortChange={(s) => {
                setWbSort(s);
                setWbPage(1);
              }}
              onRowClick={openWorkbook}
              stickyFirstColumn={false}
              toolbar={
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={effectiveFolderFilter}
                    onValueChange={(v) => {
                      setFolderFilter(v);
                      setWbPage(1);
                    }}
                  >
                    <SelectTrigger
                      className="h-8 w-[200px]"
                      data-testid="select-folder-filter"
                    >
                      <Folder className="mr-1.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All folders</SelectItem>
                      <SelectItem value="unfiled">Unfiled</SelectItem>
                      {folders.map((f) => (
                        <SelectItem
                          key={f.id}
                          value={f.id}
                          data-testid={`option-folder-${f.id}`}
                        >
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedFolder && selectedFolder.ownerId === currentUserId && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          data-testid={`btn-folder-menu-${selectedFolder.id}`}
                          aria-label={`Actions for folder ${selectedFolder.name}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          onClick={() => openRenameFolder(selectedFolder)}
                          data-testid={`menu-rename-folder-${selectedFolder.id}`}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          Rename folder
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => openDeleteFolder(selectedFolder)}
                          className="text-destructive focus:text-destructive"
                          data-testid={`menu-delete-folder-${selectedFolder.id}`}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete folder
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              }
              pagination={{
                page: wbSafePage,
                pageSize: wbPageSize,
                total: wbTotal,
                onPageChange: setWbPage,
                onPageSizeChange: (size) => {
                  setWbPageSize(size);
                  setWbPage(1);
                },
                pageSizeOptions: [25, 50, 100],
              }}
              emptyState={
                <span data-testid="workbooks-no-match">
                  {searchTerm
                    ? "No workbooks match your search."
                    : effectiveFolderFilter === "unfiled"
                      ? "No unfiled workbooks."
                      : "No workbooks in this folder."}
                </span>
              }
            />
          </div>
        )}

        {/* ── Documents section (NoBull Docs) ───────────────────────────────── */}
        <DocumentsSection />

        {/* ── Templates section (CEO only) ──────────────────────────────────── */}
        {isCeo && (
          <div className="mt-12" data-testid="section-templates">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Templates
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Manage reusable workbook templates.
                </p>
              </div>
            </div>

            {templatesQuery.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading templates…
              </div>
            ) : allTemplates.length === 0 && archivedTemplates.length === 0 ? (
              <EmptyState
                testId="templates-empty"
                icon={<LayoutTemplate />}
                title="No templates yet"
                description={'Use "Save as Template" on any workbook to create a reusable template.'}
              />
            ) : (
              <div className="space-y-6">
                {allTemplates.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                      Active ({allTemplates.length})
                    </p>
                    <div className="divide-y divide-[#E8DED5] rounded-lg border border-[#E8DED5] bg-card overflow-hidden">
                      {allTemplates.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-3 px-4 py-3"
                          data-testid={`row-template-${t.id}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <LayoutTemplate className="h-4 w-4 shrink-0 text-primary" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">
                                {t.name}
                              </p>
                              {t.description && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {t.description}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Edit template"
                              onClick={() => openRenameTemplate(t)}
                              data-testid={`btn-edit-template-${t.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Archive template"
                              onClick={() => openArchiveTemplate(t)}
                              data-testid={`btn-archive-template-${t.id}`}
                            >
                              <Archive className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              title="Delete template"
                              onClick={() => openDeleteTemplate(t)}
                              data-testid={`btn-delete-template-${t.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {archivedTemplates.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                      Archived ({archivedTemplates.length})
                    </p>
                    <div className="divide-y divide-[#E8DED5] rounded-lg border border-[#E8DED5] bg-muted/60 overflow-hidden">
                      {archivedTemplates.map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-3 px-4 py-3"
                          data-testid={`row-template-archived-${t.id}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <LayoutTemplate className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-muted-foreground truncate">
                                {t.name}
                              </p>
                              <Badge variant="outline" className="mt-0.5 text-xs text-muted-foreground">
                                Archived
                              </Badge>
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Restore template"
                              onClick={() => archiveTemplateMut.mutate({ id: t.id, archived: false })}
                              data-testid={`btn-restore-template-${t.id}`}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              title="Delete template permanently"
                              onClick={() => openDeleteTemplate(t)}
                              data-testid={`btn-delete-archived-template-${t.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Dashboards section (owners/CEO) ───────────────────────────────── */}
        {isOwnerOrCeo && publishedDashboards.length > 0 && (
          <div className="mt-12" data-testid="section-dashboards">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <LayoutDashboard className="h-4 w-4 text-primary" />
                  Dashboards
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Published read-only views shared with your team.
                </p>
              </div>
            </div>
            <div className="divide-y divide-[#E8DED5] rounded-lg border border-[#E8DED5] bg-card overflow-hidden">
              {publishedDashboards.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                  data-testid={`row-dashboard-${d.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Globe className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{d.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {d.tabs.length} tab{d.tabs.length !== 1 ? "s" : ""} ·{" "}
                        {d.audienceRoles?.length
                          ? d.audienceRoles.join(", ")
                          : "No role restrictions"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => setLocation(`/sheets/dashboard/${d.id}`)}
                      data-testid={`btn-view-dashboard-${d.id}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                      View
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Unpublish dashboard"
                      onClick={() => setDialog({ kind: "unpublish-dashboard", dashboard: d })}
                      data-testid={`btn-unpublish-dashboard-${d.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Create Workbook dialog (blank or from template) ───────────────── */}
      <Dialog
        open={dialog.kind === "create-workbook"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-create-workbook" className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Workbook</DialogTitle>
            <DialogDescription>
              {createMode === "template"
                ? "Choose a template to start from."
                : "Give your workbook a name and optionally choose a folder."}
            </DialogDescription>
          </DialogHeader>

          {/* Mode toggle */}
          {allTemplates.length > 0 && (
            <div className="flex gap-2 mb-2">
              <button
                type="button"
                onClick={() => setCreateMode("blank")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  createMode === "blank"
                    ? "border-primary bg-primary/5 text-primary-ink"
                    : "border-[#E8DED5] text-muted-foreground hover:border-primary/30"
                }`}
                data-testid="btn-mode-blank"
              >
                Blank workbook
              </button>
              <button
                type="button"
                onClick={() => setCreateMode("template")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  createMode === "template"
                    ? "border-primary bg-primary/5 text-primary-ink"
                    : "border-[#E8DED5] text-muted-foreground hover:border-primary/30"
                }`}
                data-testid="btn-mode-template"
              >
                From template
              </button>
            </div>
          )}

          {createMode === "template" ? (
            /* Template gallery */
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-h-60 overflow-y-auto" data-testid="template-gallery">
                {allTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    onUse={openCreateFromTemplate}
                  />
                ))}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  data-testid="btn-cancel-create-workbook"
                >
                  Cancel
                </Button>
              </DialogFooter>
            </div>
          ) : (
            /* Blank workbook form */
            <form onSubmit={handleCreateWorkbook} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-wb-name">Name</Label>
                <Input
                  id="new-wb-name"
                  value={nameField}
                  onChange={(e) => setNameField(e.target.value)}
                  placeholder="Untitled Workbook"
                  autoFocus
                  data-testid="input-new-workbook-name"
                />
              </div>
              {folders.length > 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="new-wb-folder">Folder (optional)</Label>
                  <Select value={folderField} onValueChange={setFolderField}>
                    <SelectTrigger
                      id="new-wb-folder"
                      data-testid="select-new-workbook-folder"
                    >
                      <SelectValue placeholder="No folder" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No folder</SelectItem>
                      {folders.map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  data-testid="btn-cancel-create-workbook"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!nameField.trim() || createWorkbookMut.isPending}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  data-testid="btn-submit-create-workbook"
                >
                  {createWorkbookMut.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Create
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Create Folder dialog ──────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "create-folder"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-create-folder">
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
            <DialogDescription>
              Folders help you organise your workbooks.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateFolder} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-folder-name">Folder name</Label>
              <Input
                id="new-folder-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                placeholder="My Folder"
                autoFocus
                data-testid="input-new-folder-name"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-create-folder"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || createFolderMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-create-folder"
              >
                {createFolderMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Rename Workbook dialog ────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "rename-workbook"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-rename-workbook">
          <DialogHeader>
            <DialogTitle>Rename Workbook</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRenameWorkbook} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rename-wb-name">Name</Label>
              <Input
                id="rename-wb-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                autoFocus
                data-testid="input-rename-workbook-name"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-rename-workbook"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || renameWorkbookMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-rename-workbook"
              >
                {renameWorkbookMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Rename Folder dialog ──────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "rename-folder"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-rename-folder">
          <DialogHeader>
            <DialogTitle>Rename Folder</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRenameFolder} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="rename-folder-name">Folder name</Label>
              <Input
                id="rename-folder-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                autoFocus
                data-testid="input-rename-folder-name"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-rename-folder"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || renameFolderMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-rename-folder"
              >
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Move Workbook dialog ──────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "move-workbook"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-move-workbook">
          <DialogHeader>
            <DialogTitle>Move Workbook</DialogTitle>
            <DialogDescription>
              {dialog.kind === "move-workbook"
                ? `Move "${dialog.workbook.name}" to a different folder.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleMoveWorkbook} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="move-wb-folder">Folder</Label>
              <Select value={folderField} onValueChange={setFolderField}>
                <SelectTrigger
                  id="move-wb-folder"
                  data-testid="select-move-workbook-folder"
                >
                  <SelectValue placeholder="No folder (unfiled)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No folder (unfiled)</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-move-workbook"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={moveWorkbookMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-move-workbook"
              >
                {moveWorkbookMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Move
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Duplicate Workbook dialog ─────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "duplicate-workbook"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-duplicate-workbook">
          <DialogHeader>
            <DialogTitle>Duplicate Workbook</DialogTitle>
            <DialogDescription>
              {dialog.kind === "duplicate-workbook"
                ? `A copy of "${dialog.workbook.name}" will be created with all its data.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleDuplicate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="dup-wb-name">Name for the copy</Label>
              <Input
                id="dup-wb-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                autoFocus
                data-testid="input-duplicate-workbook-name"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-duplicate-workbook"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || duplicateWorkbookMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-duplicate-workbook"
              >
                {duplicateWorkbookMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Duplicate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Save as Template dialog ───────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "save-as-template"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-save-as-template">
          <DialogHeader>
            <DialogTitle>Save as Template</DialogTitle>
            <DialogDescription>
              {dialog.kind === "save-as-template"
                ? `Save a copy of "${dialog.workbook.name}" as a reusable template.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveAsTemplate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tmpl-name">Template name</Label>
              <Input
                id="tmpl-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                placeholder="Template name"
                autoFocus
                data-testid="input-template-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tmpl-desc">Description (optional)</Label>
              <Textarea
                id="tmpl-desc"
                value={descField}
                onChange={(e) => setDescField(e.target.value)}
                placeholder="Briefly describe when to use this template…"
                rows={3}
                data-testid="input-template-description"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-save-as-template"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || saveAsTemplateMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-save-as-template"
              >
                {saveAsTemplateMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save Template
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Create from Template dialog ───────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "create-from-template"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-create-from-template">
          <DialogHeader>
            <DialogTitle>New Workbook from Template</DialogTitle>
            <DialogDescription>
              {dialog.kind === "create-from-template"
                ? `Starting from template: "${dialog.template.name}"`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateFromTemplate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="from-tmpl-name">Workbook name</Label>
              <Input
                id="from-tmpl-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                placeholder="Untitled Workbook"
                autoFocus
                data-testid="input-from-template-workbook-name"
              />
            </div>
            {folders.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="from-tmpl-folder">Folder (optional)</Label>
                <Select value={folderField} onValueChange={setFolderField}>
                  <SelectTrigger
                    id="from-tmpl-folder"
                    data-testid="select-from-template-folder"
                  >
                    <SelectValue placeholder="No folder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No folder</SelectItem>
                    {folders.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-from-template"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || createFromTemplateMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-from-template"
              >
                {createFromTemplateMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Edit Template dialog (rename + update description) ───────────── */}
      <Dialog
        open={dialog.kind === "rename-template"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-rename-template">
          <DialogHeader>
            <DialogTitle>Edit Template</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleRenameTemplate} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-tmpl-name">Name</Label>
              <Input
                id="edit-tmpl-name"
                value={nameField}
                onChange={(e) => setNameField(e.target.value)}
                autoFocus
                data-testid="input-edit-template-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-tmpl-desc">Description (optional)</Label>
              <Textarea
                id="edit-tmpl-desc"
                value={descField}
                onChange={(e) => setDescField(e.target.value)}
                rows={3}
                data-testid="input-edit-template-description"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeDialog}
                data-testid="btn-cancel-rename-template"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!nameField.trim() || renameTemplateMut.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                data-testid="btn-submit-rename-template"
              >
                {renameTemplateMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Archive Template confirm ──────────────────────────────────────── */}
      <AlertDialog
        open={dialog.kind === "archive-template"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <AlertDialogContent data-testid="dialog-archive-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive template?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "archive-template"
                ? `"${dialog.template.name}" will be archived and hidden from the template gallery. You can restore it later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={closeDialog}
              data-testid="btn-cancel-archive-template"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (dialog.kind === "archive-template") {
                  archiveTemplateMut.mutate({ id: dialog.template.id, archived: true });
                }
              }}
              data-testid="btn-confirm-archive-template"
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete Workbook confirm ───────────────────────────────────────── */}
      <AlertDialog
        open={dialog.kind === "delete-workbook"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <AlertDialogContent data-testid="dialog-delete-workbook">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workbook?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "delete-workbook"
                ? `"${dialog.workbook.name}" will be permanently deleted. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={closeDialog}
              data-testid="btn-cancel-delete-workbook"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (dialog.kind === "delete-workbook") {
                  deleteWorkbookMut.mutate(dialog.workbook.id);
                }
              }}
              data-testid="btn-confirm-delete-workbook"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete Folder confirm ─────────────────────────────────────────── */}
      <AlertDialog
        open={dialog.kind === "delete-folder"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <AlertDialogContent data-testid="dialog-delete-folder">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "delete-folder"
                ? `"${dialog.folder.name}" will be deleted. Workbooks inside will become unfiled.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={closeDialog}
              data-testid="btn-cancel-delete-folder"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (dialog.kind === "delete-folder") {
                  deleteFolderMut.mutate(dialog.folder.id);
                }
              }}
              data-testid="btn-confirm-delete-folder"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete Template confirm ───────────────────────────────────────── */}
      <AlertDialog
        open={dialog.kind === "delete-template"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <AlertDialogContent data-testid="dialog-delete-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "delete-template"
                ? `"${dialog.template.name}" will be permanently deleted. Workbooks created from it are not affected.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={closeDialog}
              data-testid="btn-cancel-delete-template"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (dialog.kind === "delete-template") {
                  deleteTemplateMut.mutate(dialog.template.id);
                }
              }}
              data-testid="btn-confirm-delete-template"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* ── Import dialog ─────────────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "import"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="max-w-md" data-testid="dialog-import">
          <DialogHeader>
            <DialogTitle>Import spreadsheet</DialogTitle>
            <DialogDescription>
              Upload an Excel (.xlsx, .xls) or CSV file to create a new workbook.
              Charts, pivot tables, images, and macros are not imported.
            </DialogDescription>
          </DialogHeader>

          {/* Drag-and-drop zone */}
          <div
            data-testid="import-drop-zone"
            role="button"
            tabIndex={0}
            aria-label="Choose a spreadsheet file to import"
            className={`
              mt-2 flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed
              px-6 py-10 text-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              ${isDragOver
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40"
              }
            `}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault();
              setIsDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void handleImportFile(file); // fire-and-forget: errors handled inside handleImportFile
            }}
          >
            <Upload className="h-8 w-8 text-primary/50" />
            <div>
              <p className="text-sm font-medium text-foreground">
                Drag &amp; drop a file here, or click to browse
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                .xlsx, .xls, .csv — up to 50 MB
              </p>
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={closeDialog}
              data-testid="btn-cancel-import"
            >
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => fileInputRef.current?.click()}
              data-testid="btn-browse-import"
            >
              Browse files
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Import summary dialog ─────────────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "import-summary"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent className="max-w-md" data-testid="dialog-import-summary">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0" />
              Import complete
            </DialogTitle>
            <DialogDescription>
              {dialog.kind === "import-summary"
                ? `"${dialog.workbookName}" was created from your file.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {dialog.kind === "import-summary" && (
            <div className="space-y-4">
              {/* Stats */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">Sheets</p>
                  <p className="font-semibold text-foreground">{dialog.report.sheetCount}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">Cells</p>
                  <p className="font-semibold text-foreground">{dialog.report.cellCount.toLocaleString()}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">Formulas</p>
                  <p className="font-semibold text-foreground">{dialog.report.formulaCount.toLocaleString()}</p>
                </div>
                <div className="rounded-md bg-muted/50 px-3 py-2">
                  <p className="text-xs text-muted-foreground">Merged cells</p>
                  <p className="font-semibold text-foreground">{dialog.report.mergeCount.toLocaleString()}</p>
                </div>
              </div>

              {/* Skipped items */}
              {dialog.report.skipped.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <p className="text-xs font-medium text-amber-700">
                      {dialog.report.skipped.length} item{dialog.report.skipped.length === 1 ? "" : "s"} not imported
                    </p>
                  </div>
                  <ul className="space-y-1">
                    {dialog.report.skipped.map((item, i) => (
                      <li key={i} className="text-xs text-amber-700 flex items-start gap-1">
                        <span className="mt-0.5 shrink-0">•</span>
                        <span>{item.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Kind badges */}
              {dialog.report.skipped.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {Array.from(new Set(dialog.report.skipped.map((s) => s.kind))).map((k) => (
                    <Badge key={k} variant="secondary" className="text-xs">
                      {k.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="mt-2">
            <Button
              variant="outline"
              onClick={closeDialog}
              data-testid="btn-dismiss-import-summary"
            >
              Close
            </Button>
            {dialog.kind === "import-summary" && (
              <Button
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={() => {
                  const id = dialog.workbookId;
                  closeDialog();
                  setLocation(`/sheets/${id}`);
                }}
                data-testid="btn-open-imported-workbook"
              >
                Open workbook
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Share Workbook dialog ─────────────────────────────────────────── */}
      {dialog.kind === "share-workbook" && (
        <ShareDialog
          open
          onClose={closeDialog}
          workbookId={dialog.workbook.id}
          workbookName={dialog.workbook.name}
        />
      )}

      {/* ── Publish as Dashboard dialog ───────────────────────────────────── */}
      <Dialog
        open={dialog.kind === "publish-dashboard"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <DialogContent data-testid="dialog-publish-dashboard" className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LayoutDashboard className="h-4 w-4 text-primary" />
              Publish as Dashboard
            </DialogTitle>
            <DialogDescription>
              Share a read-only view of selected tabs with your team. Viewers won&apos;t be able to edit.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Title */}
            <div className="space-y-1">
              <Label htmlFor="dash-title">Dashboard title</Label>
              <Input
                id="dash-title"
                value={dashTitle}
                onChange={(e) => setDashTitle(e.target.value)}
                placeholder="e.g. Q2 Performance Overview"
                data-testid="input-dashboard-title"
              />
            </div>

            {/* Tab selection */}
            <div className="space-y-2">
              <Label>Tabs to include</Label>
              {tabsQuery.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading tabs…
                </div>
              ) : (tabsQuery.data?.tabs ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground italic">No tabs found in this workbook.</p>
              ) : (
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {(tabsQuery.data?.tabs ?? []).map((tab) => (
                    <label
                      key={tab.sheetId}
                      className="flex items-center gap-2 cursor-pointer text-sm"
                      data-testid={`tab-check-${tab.sheetId}`}
                    >
                      <Checkbox
                        checked={dashSelectedTabIds.has(tab.sheetId)}
                        onCheckedChange={(checked) => {
                          setDashSelectedTabIds((prev) => {
                            const next = new Set(prev);
                            if (checked) next.add(tab.sheetId);
                            else next.delete(tab.sheetId);
                            return next;
                          });
                        }}
                      />
                      {tab.sheetName}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* Audience roles */}
            <div className="space-y-2">
              <Label>Visible to roles</Label>
              <p className="text-xs text-muted-foreground">Leave all unchecked to allow any authenticated user.</p>
              <div className="grid grid-cols-2 gap-1.5">
                {AVAILABLE_ROLES.map((role) => (
                  <label
                    key={role}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                    data-testid={`role-check-${role}`}
                  >
                    <Checkbox
                      checked={dashRoles.has(role)}
                      onCheckedChange={(checked) => {
                        setDashRoles((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(role);
                          else next.delete(role);
                          return next;
                        });
                      }}
                    />
                    {role.replace(/_/g, " ")}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} data-testid="btn-cancel-publish-dashboard">
              Cancel
            </Button>
            <Button
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={
                !dashTitle.trim() ||
                dashSelectedTabIds.size === 0 ||
                publishDashboardMut.isPending
              }
              onClick={() => {
                if (dialog.kind !== "publish-dashboard") return;
                const tabs = (tabsQuery.data?.tabs ?? []).filter((t) =>
                  dashSelectedTabIds.has(t.sheetId)
                );
                publishDashboardMut.mutate({
                  workbookId: dialog.workbook.id,
                  title: dashTitle.trim(),
                  tabs,
                  audienceRoles: Array.from(dashRoles),
                });
              }}
              data-testid="btn-confirm-publish-dashboard"
            >
              {publishDashboardMut.isPending ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Publishing…</>
              ) : (
                <><Globe className="mr-1.5 h-4 w-4" />Publish Dashboard</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Unpublish Dashboard confirm dialog ────────────────────────────── */}
      <AlertDialog
        open={dialog.kind === "unpublish-dashboard"}
        onOpenChange={(open) => !open && closeDialog()}
      >
        <AlertDialogContent data-testid="dialog-unpublish-dashboard">
          <AlertDialogHeader>
            <AlertDialogTitle>Unpublish Dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog.kind === "unpublish-dashboard"
                ? `"${dialog.dashboard.title}" will no longer be accessible to viewers. This cannot be undone — you can always republish later.`
                : "This dashboard will be unpublished."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="btn-cancel-unpublish-dashboard">
              Keep published
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (dialog.kind !== "unpublish-dashboard") return;
                unpublishDashboardMut.mutate(dialog.dashboard.workbookId);
              }}
              data-testid="btn-confirm-unpublish-dashboard"
            >
              {unpublishDashboardMut.isPending ? (
                <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Unpublishing…</>
              ) : (
                "Unpublish"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
