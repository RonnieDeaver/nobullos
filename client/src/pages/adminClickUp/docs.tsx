// ClickUp admin — docs browser/editor panel.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  FileText,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Pencil,
} from "lucide-react";
import type { Doc } from "./types";

// ─── Docs: types & helpers ────────────────────────────────────────────────────

export type DocPageListingItem = {
  id: string;
  name: string;
  parent_page_id?: string | null;
  orderindex?: number;
  date_updated?: string;
};

export type DocPageNode = DocPageListingItem & { children: DocPageNode[] };

export type DocPageContent = {
  id: string;
  name: string;
  content?: string | null;
  content_format?: string | null;
  date_updated?: string;
};

/**
 * Fidelity notice items per ClickUp Docs import/export limitations doc.
 * Ref: developer.clickup.com/docs/docsimportexportlimitations
 */
export const FIDELITY_LOST_ITEMS = [
  "toggle lists",
  "checklists",
  "banners",
  "text alignment",
  "inline highlights",
  "embedded views",
  "most embed types",
];

/**
 * Detect whether a page's content likely contains elements that markdown
 * cannot fully represent on round-trip.
 */
export function hasUnsupportedContent(content: string | null | undefined, contentFormat?: string | null): boolean {
  if (
    contentFormat &&
    contentFormat !== "text/md" &&
    contentFormat !== "markdown" &&
    contentFormat !== "md"
  ) {
    return true;
  }
  if (!content) return false;
  return (
    /- \[[ xX]\]/.test(content) ||         // checklist items
    /^:::/m.test(content) ||               // ClickUp fenced blocks (banners, toggles)
    /embedded_view|clickup_embed/i.test(content)
  );
}

/** Build a nested tree from a flat PageListing response (sorted by orderindex). */
export function buildPageTree(pages: DocPageListingItem[]): DocPageNode[] {
  const map = new Map<string, DocPageNode>();
  for (const p of pages) {
    map.set(p.id, { ...p, children: [] });
  }
  const roots: DocPageNode[] = [];
  for (const p of pages) {
    const node = map.get(p.id)!;
    if (p.parent_page_id && map.has(p.parent_page_id)) {
      map.get(p.parent_page_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: DocPageNode[]) => {
    nodes.sort((a, b) => (a.orderindex ?? 0) - (b.orderindex ?? 0));
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

// ─── Docs: PageTreeNode sub-component ────────────────────────────────────────

export function PageTreeNode({
  node,
  depth,
  selectedPageId,
  expandedIds,
  onSelect,
  onToggle,
  onAddSubPage,
}: {
  node: DocPageNode;
  depth: number;
  selectedPageId: string | null;
  expandedIds: Set<string>;
  onSelect(id: string): void;
  onToggle(id: string): void;
  onAddSubPage(parentId: string): void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedIds.has(node.id);
  const isSelected = selectedPageId === node.id;

  return (
    <div data-testid={`page-tree-node-${node.id}`}>
      <div
        className={`flex items-center gap-1 group rounded px-1 py-0.5 cursor-pointer text-xs ${
          isSelected ? "bg-blue-50 text-blue-700" : "text-foreground hover:bg-muted"
        }`}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        <button
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted-foreground"
          onClick={() => hasChildren && onToggle(node.id)}
          data-testid={`page-tree-toggle-${node.id}`}
          tabIndex={-1}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )
          ) : (
            <span className="w-3 h-3" />
          )}
        </button>
        <button
          className="flex-1 min-w-0 text-left truncate"
          onClick={() => onSelect(node.id)}
          data-testid={`page-tree-select-${node.id}`}
        >
          {node.name}
        </button>
        <button
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 text-muted-foreground hover:text-blue-600 transition-opacity"
          title="Add sub-page"
          onClick={() => onAddSubPage(node.id)}
          data-testid={`page-tree-add-sub-${node.id}`}
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <PageTreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            selectedPageId={selectedPageId}
            expandedIds={expandedIds}
            onSelect={onSelect}
            onToggle={onToggle}
            onAddSubPage={onAddSubPage}
          />
        ))}
    </div>
  );
}

// ─── Docs: PageEditorPanel sub-component ─────────────────────────────────────

export function PageEditorPanel({
  workspaceId,
  docId,
  pageId,
  onSaved,
}: {
  workspaceId: string;
  docId: string;
  pageId: string;
  onSaved(): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const pageQ = useQuery<{ page: DocPageContent }>({
    queryKey: ["/api/clickup/docs/page", workspaceId, docId, pageId],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
        { credentials: "include" },
      ).then((r) => r.json()),
  });

  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [pendingSave, setPendingSave] = useState(false);

  const page = pageQ.data?.page;

  function startEdit() {
    setEditContent(page?.content ?? "");
    setIsEditing(true);
    setPendingSave(false);
  }

  function cancelEdit() {
    setIsEditing(false);
    setPendingSave(false);
  }

  const saveMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent, content_format: "text/md" }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/clickup/docs/page", workspaceId, docId, pageId],
      }); // fire-and-forget: cache refresh only
      setIsEditing(false);
      setPendingSave(false);
      toast({ title: "Page saved" });
      onSaved();
    },
    onError: (e: any) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  function handleSaveClick() {
    if (!pendingSave && page && hasUnsupportedContent(page.content, page.content_format)) {
      setPendingSave(true);
      return;
    }
    saveMut.mutate();
  }

  if (pageQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground p-4">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading page…
      </div>
    );
  }
  if (!page) {
    return <p className="text-xs text-muted-foreground p-4">Failed to load page.</p>;
  }

  const unsupported = hasUnsupportedContent(page.content, page.content_format);

  return (
    <div className="flex flex-col gap-3" data-testid="page-editor-panel">
      {/* Page header */}
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground flex-1 truncate">{page.name}</h3>
        {page.date_updated && (
          <span className="text-[10px] text-muted-foreground">
            Updated {new Date(Number(page.date_updated)).toLocaleDateString()}
          </span>
        )}
        {!isEditing && (
          <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={startEdit} data-testid="button-edit-page">
            <Pencil className="w-3 h-3 mr-1" /> Edit
          </Button>
        )}
      </div>

      {/* Persistent fidelity notice — always shown */}
      <div
        className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-xs text-amber-800"
        data-testid="docs-fidelity-notice"
      >
        <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
        <span>
          <strong>Markdown editing note:</strong> This editor uses markdown. Content such as{" "}
          {FIDELITY_LOST_ITEMS.join(", ")} may not survive a save round-trip.
        </span>
      </div>

      {/* Stronger pre-save warning if page has rich content */}
      {isEditing && unsupported && pendingSave && (
        <div
          className="flex items-start gap-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-xs text-red-800"
          data-testid="docs-fidelity-warning-strong"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-red-600" />
          <div>
            <strong>Warning:</strong> This page appears to contain rich ClickUp content (e.g. checklists,
            toggle lists, banners, or embedded views). Saving as markdown will permanently lose that formatting.
            Click <strong>Save anyway</strong> to confirm, or <strong>Cancel</strong> to discard.
          </div>
        </div>
      )}

      {/* Editor / viewer */}
      {isEditing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={editContent}
            onChange={(e) => { setEditContent(e.target.value); setPendingSave(false); }}
            className="font-mono text-xs min-h-[320px] resize-y"
            placeholder="Markdown content…"
            data-testid="textarea-page-content"
          />
          <div className="flex gap-2 justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={cancelEdit}
              disabled={saveMut.isPending}
              data-testid="button-cancel-edit-page"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
              onClick={handleSaveClick}
              disabled={saveMut.isPending}
              data-testid={pendingSave && unsupported ? "button-save-page-anyway" : "button-save-page"}
            >
              {saveMut.isPending ? (
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              ) : null}
              {pendingSave && unsupported ? "Save anyway" : "Save"}
            </Button>
          </div>
        </div>
      ) : (
        <div
          className="text-xs text-foreground whitespace-pre-wrap bg-muted/50 rounded border p-3 min-h-[120px] max-h-[480px] overflow-y-auto font-mono"
          data-testid="page-content-view"
        >
          {page.content?.trim()
            ? page.content
            : <span className="italic text-muted-foreground">No content yet. Click Edit to add content.</span>}
        </div>
      )}
    </div>
  );
}

// ─── Docs: CreateDocDialog ────────────────────────────────────────────────────

export function CreateDocDialog({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  onClose(): void;
  onCreated(doc: Doc): void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/workspaces/${workspaceId}/docs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          parent: { id: workspaceId, type: 7 },
          create_page: true,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: `Doc "${name.trim()}" created` });
      setName("");
      onCreated(data.doc ?? data);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create doc", description: e.message, variant: "destructive" }),
  });

  function handleConfirm() {
    if (!name.trim()) return;
    createMut.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create Doc</DialogTitle>
          <DialogDescription>Create a new Doc in this workspace.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <Label className="text-xs mb-1 block">Doc name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Doc name…"
              className="h-8 text-xs"
              onKeyDown={(e) => e.key === "Enter" && handleConfirm()}
              autoFocus
              data-testid="input-new-doc-name"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={createMut.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!name.trim() || createMut.isPending}
            data-testid="button-confirm-create-doc"
          >
            {createMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Docs: CreatePageDialog ───────────────────────────────────────────────────

export function CreatePageDialog({
  open,
  workspaceId,
  docId,
  parentPageId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  docId: string;
  parentPageId: string | null;
  onClose(): void;
  onCreated(pageId: string): void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");

  const createMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = {
        name: name.trim(),
        content: "",
        content_format: "text/md",
      };
      if (parentPageId) body.parent_page_id = parentPageId;
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/docs/${docId}/pages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      const pageId = data.page?.id ?? data.id;
      toast({ title: `Page "${name.trim()}" created` });
      setName("");
      onCreated(pageId);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create page", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{parentPageId ? "Add Sub-Page" : "Add Page"}</DialogTitle>
          <DialogDescription>
            {parentPageId ? "Create a sub-page under the selected page." : "Create a top-level page in this Doc."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <Label className="text-xs mb-1 block">Page name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Page name…"
              className="h-8 text-xs"
              onKeyDown={(e) => e.key === "Enter" && createMut.mutate()}
              autoFocus
              data-testid="input-new-page-name"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={createMut.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => createMut.mutate()}
            disabled={!name.trim() || createMut.isPending}
            data-testid="button-confirm-create-page"
          >
            {createMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Docs: DocsPanel ─────────────────────────────────────────────────────────

export function DocsPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [expandedPageIds, setExpandedPageIds] = useState<Set<string>>(new Set());
  const [showCreateDoc, setShowCreateDoc] = useState(false);
  const [createPageParentId, setCreatePageParentId] = useState<string | null | undefined>(
    undefined,
  ); // undefined = hidden, null = top-level, string = sub-page

  // Debounce search input 400 ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const docsQ = useQuery<{ docs: Doc[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "docs", debouncedQ],
    queryFn: () => {
      const url = debouncedQ
        ? `/api/clickup/workspaces/${workspaceId}/docs?query=${encodeURIComponent(debouncedQ)}`
        : `/api/clickup/workspaces/${workspaceId}/docs`;
      return fetch(url, { credentials: "include" }).then((r) => r.json());
    },
    staleTime: 30_000,
  });

  const pageListingQ = useQuery<{ pages: DocPageListingItem[] }>({
    queryKey: ["/api/clickup/docs/page-listing", workspaceId, selectedDoc?.id],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/docs/${selectedDoc!.id}/page-listing`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!selectedDoc,
    staleTime: 30_000,
  });

  const docs = docsQ.data?.docs ?? [];
  const pageListing = pageListingQ.data?.pages ?? [];
  const pageTree = buildPageTree(pageListing);

  function handleDocSelect(doc: Doc) {
    setSelectedDoc(doc);
    setSelectedPageId(null);
    setExpandedPageIds(new Set());
  }

  function handleTogglePage(id: string) {
    setExpandedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleAddSubPage(parentId: string) {
    setCreatePageParentId(parentId);
  }

  function invalidatePageListing() {
    void queryClient.invalidateQueries({
      queryKey: ["/api/clickup/docs/page-listing", workspaceId, selectedDoc?.id],
    }); // fire-and-forget: cache refresh only
  }

  // ── Doc list view ────────────────────────────────────────────────────────

  if (!selectedDoc) {
    return (
      <div data-testid="panel-docs">
        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search docs…"
              className="h-8 text-xs pl-7"
              data-testid="input-docs-search"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => setShowCreateDoc(true)}
            data-testid="button-create-doc"
          >
            <Plus className="w-3 h-3 mr-1" /> New Doc
          </Button>
        </div>

        {docsQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading docs…
          </div>
        ) : docs.length === 0 ? (
          <p className="text-xs text-muted-foreground italic" data-testid="text-no-docs">
            {debouncedQ ? `No docs matching "${debouncedQ}"` : "No docs in this workspace"}
          </p>
        ) : (
          <div className="space-y-1">
            {docs.map((d) => (
              <button
                key={d.id}
                className="w-full flex items-center gap-2 bg-card border rounded px-3 py-2 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors"
                onClick={() => handleDocSelect(d)}
                data-testid={`doc-row-${d.id}`}
              >
                <FileText className="w-4 h-4 text-blue-400 flex-shrink-0" />
                <span className="text-sm text-foreground flex-1 truncate">{d.name}</span>
                {d.date_updated && (
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(Number(d.date_updated)).toLocaleDateString()}
                  </span>
                )}
                <ChevronRight className="w-3.5 h-3.5 text-gray-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        )}

        <CreateDocDialog
          open={showCreateDoc}
          workspaceId={workspaceId}
          onClose={() => setShowCreateDoc(false)}
          onCreated={(doc) => {
            setShowCreateDoc(false);
            void queryClient.invalidateQueries({
              queryKey: ["/api/clickup/workspaces", workspaceId, "docs"],
            }); // fire-and-forget: cache refresh only
            handleDocSelect(doc);
          }}
        />
      </div>
    );
  }

  // ── Doc view: page tree + page content ──────────────────────────────────

  return (
    <div data-testid="panel-doc-view">
      {/* Doc header */}
      <div className="flex items-center gap-2 mb-3">
        <button
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => { setSelectedDoc(null); setSelectedPageId(null); }}
          data-testid="button-back-to-docs"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> All Docs
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-foreground truncate">{selectedDoc.name}</span>
        <a
          href="#"
          className="ml-auto text-[10px] text-muted-foreground hover:text-blue-600 flex items-center gap-0.5"
          onClick={(e) => { e.preventDefault(); invalidatePageListing(); }}
          data-testid="button-refresh-pages"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </a>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3">
        {/* Page tree sidebar */}
        <div className="border rounded bg-muted/50 p-2" data-testid="page-tree-panel">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Pages</span>
            <button
              className="text-[10px] text-blue-600 hover:text-blue-800 flex items-center gap-0.5"
              onClick={() => setCreatePageParentId(null)}
              data-testid="button-add-top-page"
            >
              <Plus className="w-3 h-3" /> Add page
            </button>
          </div>

          {pageListingQ.isLoading ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
            </div>
          ) : pageTree.length === 0 ? (
            <p className="text-[10px] text-muted-foreground italic">No pages yet</p>
          ) : (
            <div className="space-y-0.5">
              {pageTree.map((node) => (
                <PageTreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  selectedPageId={selectedPageId}
                  expandedIds={expandedPageIds}
                  onSelect={(id) => setSelectedPageId(id)}
                  onToggle={handleTogglePage}
                  onAddSubPage={handleAddSubPage}
                />
              ))}
            </div>
          )}
        </div>

        {/* Page content panel */}
        <div className="min-w-0">
          {!selectedPageId ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-2" data-testid="prompt-select-page">
              <FileText className="w-6 h-6" />
              <p className="text-xs">Select a page from the tree to view or edit it</p>
            </div>
          ) : (
            <PageEditorPanel
              key={selectedPageId}
              workspaceId={workspaceId}
              docId={selectedDoc.id}
              pageId={selectedPageId}
              onSaved={invalidatePageListing}
            />
          )}
        </div>
      </div>

      {/* Create page dialog */}
      {createPageParentId !== undefined && (
        <CreatePageDialog
          open={createPageParentId !== undefined}
          workspaceId={workspaceId}
          docId={selectedDoc.id}
          parentPageId={createPageParentId}
          onClose={() => setCreatePageParentId(undefined)}
          onCreated={(pageId) => {
            setCreatePageParentId(undefined);
            invalidatePageListing();
            setSelectedPageId(pageId);
            if (createPageParentId) {
              setExpandedPageIds((prev) => new Set([...prev, createPageParentId!]));
            }
          }}
        />
      )}
    </div>
  );
}

