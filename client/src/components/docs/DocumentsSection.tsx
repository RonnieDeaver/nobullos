/**
 * DocumentsSection — NoBull Docs list/create/import UI.
 *
 * Reused in two places:
 *   - SheetsLibrary (no clientId): the global "Documents" section listing all
 *     docs the user can access (own + client-linked).
 *   - ClientFilesTab (clientId set): the client's documents, created/imported
 *     directly against that client so they appear in its Files tab.
 *
 * Flows: create (POST → navigate to /docs/:id), upload .docx (import →
 * navigate), open, rename, download .docx, delete (owner/CEO only —
 * the menu item is always shown; the server enforces ownership).
 */

import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileText,
  FilePlus2,
  Upload,
  MoreHorizontal,
  Pencil,
  Download,
  Share2,
  Trash2,
  Loader2,
} from "lucide-react";
import { DocShareDialog } from "@/components/docs/DocShareDialog";
import {
  OsTable,
  type OsTableColumn,
  type OsTableSort,
} from "@/components/ui/os-table";

export interface DocDocumentListItem {
  id: string;
  name: string;
  ownerId: string;
  clientId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface ImportReport {
  paragraphCount: number;
  tableCount: number;
  imagesImported: number;
  imagesSkipped: number;
  entries: { type: string; detail?: string }[];
}

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

function describeImportReport(report: ImportReport | undefined): string | null {
  if (!report) return null;
  const notes: string[] = [];
  if (report.imagesSkipped > 0)
    notes.push(
      `${report.imagesSkipped} unsupported image${report.imagesSkipped === 1 ? "" : "s"}/drawing${report.imagesSkipped === 1 ? "" : "s"} skipped`,
    );
  const unsupported = report.entries.filter((e) => e.type === "unsupported");
  if (unsupported.length > 0)
    notes.push(`${unsupported.length} construct${unsupported.length === 1 ? "" : "s"} simplified`);
  return notes.length > 0 ? notes.join("; ") : null;
}

interface DocumentsSectionProps {
  /** When set, documents are listed/created/imported for this client. */
  clientId?: string;
  /** Section heading — defaults to "Documents". */
  title?: string;
  /** Optional sub-heading under the title. */
  subtitle?: string;
}

export default function DocumentsSection({
  clientId,
  title = "Documents",
  subtitle,
}: DocumentsSectionProps) {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [renameTarget, setRenameTarget] = useState<DocDocumentListItem | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DocDocumentListItem | null>(null);
  const [shareTarget, setShareTarget] = useState<DocDocumentListItem | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Task #4371 — bounded list: client-paginated OsTable instead of the
  // unbounded card grid (audit P2-7 §7.3).
  const [docSort, setDocSort] = useState<OsTableSort | null>({
    key: "updated",
    direction: "desc",
  });
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(10);

  // Task #4488 — server mode: sort + pagination run on the server; only the
  // current page is downloaded. Invalidation prefix-matches the URL string.
  const pagedListUrl = (() => {
    const params = new URLSearchParams();
    if (clientId) params.set("clientId", clientId);
    if (docSort) {
      params.set("sort", docSort.key);
      params.set("dir", docSort.direction);
    }
    params.set("limit", String(docPageSize));
    params.set("offset", String((docPage - 1) * docPageSize));
    return `/api/docs/documents?${params.toString()}`;
  })();

  const documentsQuery = useQuery<{
    documents: DocDocumentListItem[];
    total?: number;
  }>({
    queryKey: [pagedListUrl],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const documents = documentsQuery.data?.documents ?? [];
  const docTotal = documentsQuery.data?.total ?? documents.length;
  const currentUserId = user?.id;
  const isCeo = user?.role === "ceo";

  function invalidate() {
    // void: fire-and-forget cache refresh; errors surface via query state.
    // Paged keys carry query params, so prefix-match by URL string —
    // this covers both client-scoped and global list shapes.
    void queryClient.invalidateQueries({
      predicate: (query) =>
        String(query.queryKey[0]).startsWith("/api/docs/documents"),
    });
  }

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/docs/documents", {
        name: "Untitled document",
        ...(clientId ? { clientId } : {}),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to create document");
      return res.json();
    },
    onSuccess: (data) => {
      invalidate();
      if (data.document?.id) setLocation(`/docs/${data.document.id}`);
    },
    onError: (err: any) => {
      toast({
        title: "Could not create document",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const renameMut = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PATCH", `/api/docs/documents/${id}`, { name });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to rename");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setRenameTarget(null);
      toast({ title: "Document renamed" });
    },
    onError: (err: any) => {
      toast({
        title: "Rename failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/docs/documents/${id}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setDeleteTarget(null);
      toast({ title: "Document deleted" });
    },
    onError: (err: any) => {
      toast({
        title: "Delete failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  async function handleImportFile(file: File) {
    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (clientId) formData.append("clientId", clientId);
      const res = await fetch("/api/docs/documents/import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ?? `Import failed (${res.status})`);
      }
      invalidate();
      const reportNote = describeImportReport(data.report);
      toast({
        title: "Document imported",
        description: reportNote ?? "Ready to edit.",
      });
      if (data.document?.id) setLocation(`/docs/${data.document.id}`);
    } catch (err: any) {
      toast({
        title: "Import failed",
        description: err?.message ?? "Could not import this .docx file.",
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function handleDownloadDocx(docItem: DocDocumentListItem) {
    const a = document.createElement("a");
    a.href = `/api/docs/documents/${docItem.id}/export/docx`;
    a.download = `${docItem.name}.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ── Server mode (Task #4488): rows arrive pre-sorted and pre-sliced ──────
  const docPageCount = Math.max(1, Math.ceil(docTotal / docPageSize));
  const docSafePage = Math.min(docPage, docPageCount);
  const pagedDocuments = documents;

  const documentColumns: Array<OsTableColumn<DocDocumentListItem>> = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      cell: (docItem) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileText
            className="h-4 w-4 shrink-0 text-primary"
            aria-hidden="true"
          />
          <span
            className="truncate text-sm font-medium text-foreground"
            data-testid={`text-document-name-${docItem.id}`}
          >
            {docItem.name}
          </span>
        </div>
      ),
    },
    {
      key: "updated",
      header: "Edited",
      sortable: true,
      width: 120,
      cell: (docItem) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {formatDate(docItem.updatedAt)}
        </span>
      ),
    },
    {
      key: "owner",
      header: "Owner",
      sortable: true,
      width: 100,
      cell: (docItem) => (
        <span
          className="text-sm text-muted-foreground"
          data-testid={`text-document-owner-${docItem.id}`}
        >
          {docItem.ownerId === currentUserId ? "You" : "Shared"}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: 64,
      cell: (docItem) => {
        const canDelete = docItem.ownerId === currentUserId || isCeo;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                data-testid={`btn-document-menu-${docItem.id}`}
                aria-label={`Actions for ${docItem.name}`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                onClick={() => {
                  setRenameTarget(docItem);
                  setRenameValue(docItem.name);
                }}
                data-testid={`menu-rename-document-${docItem.id}`}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleDownloadDocx(docItem)}
                data-testid={`menu-download-docx-${docItem.id}`}
              >
                <Download className="mr-2 h-4 w-4" />
                Download .docx
              </DropdownMenuItem>
              {canDelete && (
                <DropdownMenuItem
                  onClick={() => setShareTarget(docItem)}
                  data-testid={`menu-share-document-${docItem.id}`}
                >
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDeleteTarget(docItem)}
                    className="text-destructive focus:text-destructive"
                    data-testid={`menu-delete-document-${docItem.id}`}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <section className="mt-12" data-testid="section-documents">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground" data-testid="documents-section-title">
            {title}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {subtitle ?? "Word documents — created and edited right here"}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept=".docx"
            className="sr-only"
            aria-label="Import Word document"
            data-testid="input-import-docx"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // void: handleImportFile catches + toasts all errors itself.
              if (file) void handleImportFile(file);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={isImporting}
            onClick={() => fileInputRef.current?.click()}
            data-testid="btn-import-docx"
          >
            {isImporting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1.5 h-4 w-4" />
            )}
            Upload .docx
          </Button>
          <Button
            size="sm"
            className="bg-primary hover:bg-[#572432] text-primary-foreground"
            disabled={createMut.isPending}
            onClick={() => createMut.mutate()}
            data-testid="btn-create-document"
          >
            {createMut.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <FilePlus2 className="mr-1.5 h-4 w-4" />
            )}
            New Document
          </Button>
        </div>
      </div>

      {documentsQuery.isLoading ? (
        <div className="flex items-center justify-center py-10" data-testid="documents-loading">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : docTotal === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border bg-muted/40 px-6 py-10 text-center"
          data-testid="documents-empty"
        >
          <FileText className="mx-auto h-8 w-8 text-muted-foreground/60" />
          <p className="mt-2 text-sm text-muted-foreground">
            No documents yet. Create one or upload a .docx to get started.
          </p>
        </div>
      ) : (
        <OsTable
          data-testid="documents-table"
          rows={pagedDocuments}
          rowKey={(docItem) => docItem.id}
          columns={documentColumns}
          sort={docSort}
          onSortChange={(s) => {
            setDocSort(s);
            setDocPage(1);
          }}
          onRowClick={(docItem) => setLocation(`/docs/${docItem.id}`)}
          stickyFirstColumn={false}
          showDensityToggle={false}
          pagination={{
            page: docSafePage,
            pageSize: docPageSize,
            total: docTotal,
            onPageChange: setDocPage,
            onPageSizeChange: (size) => {
              setDocPageSize(size);
              setDocPage(1);
            },
            pageSizeOptions: [10, 25, 50],
          }}
        />
      )}

      {/* Share dialog (owner/CEO only — Task #4053) */}
      {shareTarget && (
        <DocShareDialog
          open={!!shareTarget}
          onClose={() => setShareTarget(null)}
          documentId={shareTarget.id}
          documentName={shareTarget.name}
          ownerId={shareTarget.ownerId}
        />
      )}

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent data-testid="dialog-rename-document">
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Document name"
            data-testid="input-rename-document"
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameTarget && renameValue.trim()) {
                renameMut.mutate({ id: renameTarget.id, name: renameValue.trim() });
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} data-testid="btn-cancel-rename">
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim() || renameMut.isPending}
              onClick={() =>
                renameTarget &&
                renameMut.mutate({ id: renameTarget.id, name: renameValue.trim() })
              }
              data-testid="btn-confirm-rename"
            >
              {renameMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent data-testid="dialog-delete-document">
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              "{deleteTarget?.name}" and its version history will be permanently
              deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} data-testid="btn-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}
              data-testid="btn-confirm-delete"
            >
              {deleteMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
