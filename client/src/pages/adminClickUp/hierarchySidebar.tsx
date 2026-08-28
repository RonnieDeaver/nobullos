// ClickUp admin — workspace hierarchy sidebar.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  BookmarkPlus,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Info,
  Loader2,
  Plus,
  FolderPlus,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Settings,
  Trash2,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { CUList, Folder, Space } from "./types";
import {
  DeleteConfirmDialog,
  ListInfoDialog,
  NameDialog,
  SpaceAppsDialog,
  TemplatePickerDialog,
} from "./hierarchyDialogs";

// ─── Hierarchy sidebar ────────────────────────────────────────────────────────

export type DialogState =
  | { kind: "create-space" }
  | { kind: "create-folder"; spaceId: string }
  | { kind: "create-list-in-space"; spaceId: string }
  | { kind: "create-list-in-folder"; folderId: string; spaceId: string }
  | { kind: "create-folder-from-template"; spaceId: string }
  | { kind: "create-list-in-space-from-template"; spaceId: string }
  | { kind: "create-list-in-folder-from-template"; folderId: string; spaceId: string }
  | { kind: "rename-space"; spaceId: string; name: string }
  | { kind: "rename-folder"; folderId: string; name: string }
  | { kind: "rename-list"; listId: string; name: string }
  | { kind: "delete-space"; spaceId: string; name: string }
  | { kind: "delete-folder"; folderId: string; name: string }
  | { kind: "delete-list"; listId: string; name: string }
  | { kind: "space-apps"; space: Space }
  | { kind: "list-info"; list: CUList }
  | null;

export function HierarchySidebar({
  workspaceId,
  selectedSpace,
  selectedFolder,
  selectedList,
  onSelectSpace,
  onSelectFolder,
  onSelectList,
}: {
  workspaceId: string;
  selectedSpace: string | null;
  selectedFolder: string | null;
  selectedList: string | null;
  onSelectSpace(id: string | null): void;
  onSelectFolder(id: string | null): void;
  onSelectList(id: string | null, folderId: string | null): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [dlg, setDlg] = useState<DialogState>(null);

  const spacesQ = useQuery<{ spaces: Space[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/spaces`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: !!workspaceId,
  });

  const foldersQ = useQuery<{ folders: Folder[] }>({
    queryKey: ["/api/clickup/spaces", selectedSpace, "folders"],
    queryFn: () =>
      fetch(`/api/clickup/spaces/${selectedSpace}/folders`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: !!selectedSpace,
  });

  const spaceListsQ = useQuery<{ lists: CUList[] }>({
    queryKey: ["/api/clickup/spaces", selectedSpace, "lists"],
    queryFn: () =>
      fetch(`/api/clickup/spaces/${selectedSpace}/lists`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: !!selectedSpace,
  });

  const folderListsQ = useQuery<{ lists: CUList[] }>({
    queryKey: ["/api/clickup/folders", selectedFolder, "lists"],
    queryFn: () =>
      fetch(`/api/clickup/folders/${selectedFolder}/lists`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    enabled: !!selectedFolder,
  });

  // ─── Mutations ──────────────────────────────────────────────────────────────

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "folders"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "lists"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/clickup/folders", selectedFolder, "lists"] }); // fire-and-forget: cache refresh only
  };

  const createSpaceMut = useMutation({
    mutationFn: async (name: string) => {
      await apiRequest("POST", `/api/clickup/workspaces/${workspaceId}/spaces`, { name });
    },
    onSuccess: () => {
      toast({ title: "Space created" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create space", description: e.message, variant: "destructive" }),
  });

  const renameSpaceMut = useMutation({
    mutationFn: async ({ spaceId, name }: { spaceId: string; name: string }) => {
      await apiRequest("PUT", `/api/clickup/spaces/${spaceId}`, { name });
    },
    onSuccess: () => {
      toast({ title: "Space renamed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to rename space", description: e.message, variant: "destructive" }),
  });

  const deleteSpaceMut = useMutation({
    mutationFn: async (spaceId: string) => {
      await apiRequest("DELETE", `/api/clickup/spaces/${spaceId}`, undefined);
      return spaceId;
    },
    onSuccess: (spaceId) => {
      toast({ title: "Space deleted" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"] }); // fire-and-forget: cache refresh only
      // Deleting the currently-selected space would otherwise leave stale
      // space/folder/list ids selected, pointing task/list panels at
      // resources that no longer exist.
      if (spaceId === selectedSpace) onSelectSpace(null);
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete space", description: e.message, variant: "destructive" }),
  });

  const createFolderMut = useMutation({
    mutationFn: async ({ spaceId, name }: { spaceId: string; name: string }) => {
      await apiRequest("POST", `/api/clickup/spaces/${spaceId}/folders`, { name });
    },
    onSuccess: () => {
      toast({ title: "Folder created" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "folders"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create folder", description: e.message, variant: "destructive" }),
  });

  const renameFolderMut = useMutation({
    mutationFn: async ({ folderId, name }: { folderId: string; name: string }) => {
      await apiRequest("PUT", `/api/clickup/folders/${folderId}`, { name });
    },
    onSuccess: () => {
      toast({ title: "Folder renamed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "folders"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to rename folder", description: e.message, variant: "destructive" }),
  });

  const deleteFolderMut = useMutation({
    mutationFn: async (folderId: string) => {
      await apiRequest("DELETE", `/api/clickup/folders/${folderId}`, undefined);
      return folderId;
    },
    onSuccess: (folderId) => {
      toast({ title: "Folder deleted" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "folders"] }); // fire-and-forget: cache refresh only
      // A deleted folder's list ids no longer exist server-side; clear the
      // downstream selection so task/list panels don't keep querying them.
      if (folderId === selectedFolder) onSelectFolder(null);
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete folder", description: e.message, variant: "destructive" }),
  });

  const createListInSpaceMut = useMutation({
    mutationFn: async ({ spaceId, name }: { spaceId: string; name: string }) => {
      await apiRequest("POST", `/api/clickup/spaces/${spaceId}/lists`, { name });
    },
    onSuccess: () => {
      toast({ title: "List created" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "lists"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create list", description: e.message, variant: "destructive" }),
  });

  const createListInFolderMut = useMutation({
    mutationFn: async ({ folderId, spaceId, name }: { folderId: string; spaceId: string; name: string }) => {
      await apiRequest("POST", `/api/clickup/folders/${folderId}/lists`, { name, spaceId });
    },
    onSuccess: () => {
      toast({ title: "List created" });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/folders", selectedFolder, "lists"] }); // fire-and-forget: cache refresh only
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create list", description: e.message, variant: "destructive" }),
  });

  const [tplMaterializing, setTplMaterializing] = useState(false);

  const createFolderFromTemplateMut = useMutation({
    mutationFn: async ({ spaceId, templateId, name }: { spaceId: string; templateId: string; name: string }) => {
      const res = await apiRequest("POST", `/api/clickup/spaces/${spaceId}/folders-from-template`, {
        templateId,
        name: name || undefined,
        workspaceId,
        returnImmediately: true,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      const isMaterializing = !!data?.materializing;
      setTplMaterializing(isMaterializing);
      toast({
        title: isMaterializing
          ? "Folder is being created in ClickUp"
          : "Folder created from template",
        description: isMaterializing
          ? "The hierarchy will refresh automatically once it's ready."
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "folders"] }); // fire-and-forget: cache refresh only
      if (!isMaterializing) setDlg(null);
      // if materializing, keep dialog open so the amber banner remains visible
    },
    onError: (e: any) =>
      toast({ title: "Failed to create folder from template", description: e.message, variant: "destructive" }),
  });

  const createListInSpaceFromTemplateMut = useMutation({
    mutationFn: async ({ spaceId, templateId, name }: { spaceId: string; templateId: string; name: string }) => {
      const res = await apiRequest("POST", `/api/clickup/spaces/${spaceId}/lists-from-template`, {
        templateId,
        name: name || undefined,
        workspaceId,
        returnImmediately: true,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      const isMaterializing = !!data?.materializing;
      setTplMaterializing(isMaterializing);
      toast({
        title: isMaterializing
          ? "List is being created in ClickUp"
          : "List created from template",
        description: isMaterializing
          ? "The hierarchy will refresh automatically once it's ready."
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/spaces", selectedSpace, "lists"] }); // fire-and-forget: cache refresh only
      if (!isMaterializing) setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create list from template", description: e.message, variant: "destructive" }),
  });

  const createListInFolderFromTemplateMut = useMutation({
    mutationFn: async ({ folderId, spaceId: _spaceId, templateId, name }: { folderId: string; spaceId: string; templateId: string; name: string }) => {
      const res = await apiRequest("POST", `/api/clickup/folders/${folderId}/lists-from-template`, {
        templateId,
        name: name || undefined,
        workspaceId,
        spaceId: _spaceId,
        returnImmediately: true,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      const isMaterializing = !!data?.materializing;
      setTplMaterializing(isMaterializing);
      toast({
        title: isMaterializing
          ? "List is being created in ClickUp"
          : "List created from template",
        description: isMaterializing
          ? "The hierarchy will refresh automatically once it's ready."
          : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/clickup/folders", selectedFolder, "lists"] }); // fire-and-forget: cache refresh only
      if (!isMaterializing) setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to create list from template", description: e.message, variant: "destructive" }),
  });

  const renameListMut = useMutation({
    mutationFn: async ({ listId, name }: { listId: string; name: string }) => {
      await apiRequest("PUT", `/api/clickup/lists/${listId}`, { name });
    },
    onSuccess: () => {
      toast({ title: "List renamed" });
      invalidateAll();
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to rename list", description: e.message, variant: "destructive" }),
  });

  const deleteListMut = useMutation({
    mutationFn: async (listId: string) => {
      await apiRequest("DELETE", `/api/clickup/lists/${listId}`, undefined);
      return listId;
    },
    onSuccess: (listId) => {
      toast({ title: "List deleted" });
      invalidateAll();
      // A deleted list's tasks are gone; clear the selection so the task
      // panel doesn't keep querying a list id that no longer exists.
      if (listId === selectedList) onSelectList(null, null);
      setDlg(null);
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete list", description: e.message, variant: "destructive" }),
  });

  const spaces = spacesQ.data?.spaces?.filter((s) => !s.archived) ?? [];
  const folders = foldersQ.data?.folders?.filter((f) => !f.hidden && !f.archived) ?? [];
  const spaceLists = spaceListsQ.data?.lists ?? [];
  const folderLists = folderListsQ.data?.lists ?? [];

  const toggleSpace = (spaceId: string) => {
    setExpandedSpaces((prev) => {
      const n = new Set(prev);
      if (n.has(spaceId)) n.delete(spaceId);
      else n.add(spaceId);
      return n;
    });
  };

  const selectedSpaceObj = spaces.find((s) => s.id === selectedSpace) ?? null;
  const selectedListInSpace = spaceLists.find((l) => l.id === selectedList) ?? null;
  const selectedListInFolder = folderLists.find((l) => l.id === selectedList) ?? null;

  // Determine which list object to pass to list-info dialog
  const currentListObj: CUList | null =
    dlg?.kind === "list-info" ? dlg.list : null;

  return (
    <div className="space-y-1" data-testid="sidebar-nav">
      <div className="flex items-center justify-between mb-1">
        <Label className="text-xs text-gray-500">Spaces</Label>
        <button
          className="text-gray-400 hover:text-purple-600 transition-colors"
          onClick={() => setDlg({ kind: "create-space" })}
          title="Create Space"
          data-testid="button-create-space"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {spacesQ.isLoading ? (
        <div className="flex items-center gap-1 text-xs text-gray-400">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : spaces.length === 0 ? (
        <p className="text-xs text-gray-400 italic px-1">No spaces</p>
      ) : (
        spaces.map((space) => (
          <div key={space.id}>
            <div className={`flex items-center gap-1 group rounded ${selectedSpace === space.id ? "bg-purple-50" : "hover:bg-gray-100"}`}>
              <button
                className={`flex items-center gap-1 text-xs px-2 py-1.5 flex-1 min-w-0 ${selectedSpace === space.id ? "text-purple-700 font-medium" : "text-gray-700"}`}
                onClick={() => {
                  if (selectedSpace !== space.id) onSelectSpace(space.id);
                  toggleSpace(space.id);
                }}
                data-testid={`nav-space-${space.id}`}
              >
                {expandedSpaces.has(space.id) ? (
                  <ChevronDown className="w-3 h-3 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate">{space.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-700 transition-opacity"
                    data-testid={`menu-space-${space.id}`}
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="text-xs w-52">
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "create-folder", spaceId: space.id })}
                    data-testid={`action-create-folder-${space.id}`}
                  >
                    <FolderPlus className="w-3.5 h-3.5 mr-2" /> New Folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "create-folder-from-template", spaceId: space.id })}
                    data-testid={`action-create-folder-tpl-${space.id}`}
                  >
                    <BookmarkPlus className="w-3.5 h-3.5 mr-2" /> New Folder from Template
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "create-list-in-space", spaceId: space.id })}
                    data-testid={`action-create-list-space-${space.id}`}
                  >
                    <ListPlus className="w-3.5 h-3.5 mr-2" /> New List
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "create-list-in-space-from-template", spaceId: space.id })}
                    data-testid={`action-create-list-space-tpl-${space.id}`}
                  >
                    <BookmarkPlus className="w-3.5 h-3.5 mr-2" /> New List from Template
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "rename-space", spaceId: space.id, name: space.name })}
                    data-testid={`action-rename-space-${space.id}`}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setDlg({ kind: "space-apps", space })}
                    data-testid={`action-apps-space-${space.id}`}
                  >
                    <Settings className="w-3.5 h-3.5 mr-2" /> ClickApps
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-600 focus:text-red-700"
                    onClick={() => setDlg({ kind: "delete-space", spaceId: space.id, name: space.name })}
                    data-testid={`action-delete-space-${space.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete Space…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {expandedSpaces.has(space.id) && selectedSpace === space.id && (
              <div className="ml-3 border-l border-gray-200 pl-2 space-y-0.5 mt-0.5">
                {/* Folderless lists */}
                {spaceLists.map((l) => (
                  <div
                    key={l.id}
                    className={`flex items-center gap-1 group rounded ${selectedList === l.id && !selectedFolder ? "bg-purple-50" : "hover:bg-gray-100"}`}
                  >
                    <button
                      className={`flex items-center gap-1 text-xs px-2 py-1 flex-1 min-w-0 ${selectedList === l.id && !selectedFolder ? "text-purple-700 font-medium" : "text-gray-600"}`}
                      onClick={() => onSelectList(l.id, null)}
                      data-testid={`nav-list-${l.id}`}
                    >
                      <CheckSquare className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{l.name}</span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-700 transition-opacity"
                          data-testid={`menu-list-${l.id}`}
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-xs w-40">
                        <DropdownMenuItem
                          onClick={() => setDlg({ kind: "list-info", list: l })}
                          data-testid={`action-info-list-${l.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-2" /> Edit Info
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setDlg({ kind: "rename-list", listId: l.id, name: l.name })}
                          data-testid={`action-rename-list-${l.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-700"
                          onClick={() => setDlg({ kind: "delete-list", listId: l.id, name: l.name })}
                          data-testid={`action-delete-list-${l.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete List…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}

                {/* Folders */}
                {folders.map((folder) => (
                  <div key={folder.id}>
                    <div
                      className={`flex items-center gap-1 group rounded ${selectedFolder === folder.id ? "bg-gray-100" : "hover:bg-gray-100"}`}
                    >
                      <button
                        className={`flex items-center gap-1 text-xs px-2 py-1 flex-1 min-w-0 ${selectedFolder === folder.id ? "text-purple-700 font-medium" : "text-gray-600"}`}
                        onClick={() => onSelectFolder(folder.id)}
                        data-testid={`nav-folder-${folder.id}`}
                      >
                        <FolderOpen className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-700 transition-opacity"
                            data-testid={`menu-folder-${folder.id}`}
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="text-xs w-52">
                          <DropdownMenuItem
                            onClick={() =>
                              setDlg({
                                kind: "create-list-in-folder",
                                folderId: folder.id,
                                spaceId: space.id,
                              })
                            }
                            data-testid={`action-create-list-folder-${folder.id}`}
                          >
                            <ListPlus className="w-3.5 h-3.5 mr-2" /> New List
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setDlg({
                                kind: "create-list-in-folder-from-template",
                                folderId: folder.id,
                                spaceId: space.id,
                              })
                            }
                            data-testid={`action-create-list-folder-tpl-${folder.id}`}
                          >
                            <BookmarkPlus className="w-3.5 h-3.5 mr-2" /> New List from Template
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() =>
                              setDlg({ kind: "rename-folder", folderId: folder.id, name: folder.name })
                            }
                            data-testid={`action-rename-folder-${folder.id}`}
                          >
                            <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-700"
                            onClick={() =>
                              setDlg({ kind: "delete-folder", folderId: folder.id, name: folder.name })
                            }
                            data-testid={`action-delete-folder-${folder.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete Folder…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Lists inside folder */}
                    {selectedFolder === folder.id &&
                      folderLists.map((l) => (
                        <div
                          key={l.id}
                          className={`flex items-center gap-1 group rounded ml-3 ${selectedList === l.id ? "bg-purple-50" : "hover:bg-gray-100"}`}
                        >
                          <button
                            className={`flex items-center gap-1 text-xs pl-1 pr-2 py-1 flex-1 min-w-0 ${selectedList === l.id ? "text-purple-700 font-medium" : "text-gray-600"}`}
                            onClick={() => onSelectList(l.id, folder.id)}
                            data-testid={`nav-list-${l.id}`}
                          >
                            <CheckSquare className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{l.name}</span>
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-700 transition-opacity"
                                data-testid={`menu-list-${l.id}`}
                              >
                                <MoreHorizontal className="w-3.5 h-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="text-xs w-40">
                              <DropdownMenuItem
                                onClick={() => setDlg({ kind: "list-info", list: l })}
                                data-testid={`action-info-list-${l.id}`}
                              >
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit Info
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  setDlg({ kind: "rename-list", listId: l.id, name: l.name })
                                }
                                data-testid={`action-rename-list-${l.id}`}
                              >
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-red-600 focus:text-red-700"
                                onClick={() =>
                                  setDlg({ kind: "delete-list", listId: l.id, name: l.name })
                                }
                                data-testid={`action-delete-list-${l.id}`}
                              >
                                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete List…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}

      <NameDialog
        open={dlg?.kind === "create-space"}
        title="Create Space"
        placeholder="Space name…"
        onConfirm={(name) => createSpaceMut.mutate(name)}
        onClose={() => setDlg(null)}
        isPending={createSpaceMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "create-folder"}
        title="Create Folder"
        placeholder="Folder name…"
        onConfirm={(name) => {
          if (dlg?.kind !== "create-folder") return;
          createFolderMut.mutate({ spaceId: dlg.spaceId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={createFolderMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "create-list-in-space"}
        title="Create List"
        placeholder="List name…"
        onConfirm={(name) => {
          if (dlg?.kind !== "create-list-in-space") return;
          createListInSpaceMut.mutate({ spaceId: dlg.spaceId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={createListInSpaceMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "create-list-in-folder"}
        title="Create List in Folder"
        placeholder="List name…"
        onConfirm={(name) => {
          if (dlg?.kind !== "create-list-in-folder") return;
          createListInFolderMut.mutate({ folderId: dlg.folderId, spaceId: dlg.spaceId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={createListInFolderMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "rename-space"}
        title="Rename Space"
        placeholder="Space name…"
        initialValue={dlg?.kind === "rename-space" ? dlg.name : ""}
        onConfirm={(name) => {
          if (dlg?.kind !== "rename-space") return;
          renameSpaceMut.mutate({ spaceId: dlg.spaceId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={renameSpaceMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "rename-folder"}
        title="Rename Folder"
        placeholder="Folder name…"
        initialValue={dlg?.kind === "rename-folder" ? dlg.name : ""}
        onConfirm={(name) => {
          if (dlg?.kind !== "rename-folder") return;
          renameFolderMut.mutate({ folderId: dlg.folderId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={renameFolderMut.isPending}
      />

      <NameDialog
        open={dlg?.kind === "rename-list"}
        title="Rename List"
        placeholder="List name…"
        initialValue={dlg?.kind === "rename-list" ? dlg.name : ""}
        onConfirm={(name) => {
          if (dlg?.kind !== "rename-list") return;
          renameListMut.mutate({ listId: dlg.listId, name });
        }}
        onClose={() => setDlg(null)}
        isPending={renameListMut.isPending}
      />

      <DeleteConfirmDialog
        open={dlg?.kind === "delete-space"}
        entityType="Space"
        entityName={dlg?.kind === "delete-space" ? dlg.name : ""}
        onConfirm={() => {
          if (dlg?.kind !== "delete-space") return;
          deleteSpaceMut.mutate(dlg.spaceId);
        }}
        onClose={() => setDlg(null)}
        isPending={deleteSpaceMut.isPending}
      />

      <DeleteConfirmDialog
        open={dlg?.kind === "delete-folder"}
        entityType="Folder"
        entityName={dlg?.kind === "delete-folder" ? dlg.name : ""}
        onConfirm={() => {
          if (dlg?.kind !== "delete-folder") return;
          deleteFolderMut.mutate(dlg.folderId);
        }}
        onClose={() => setDlg(null)}
        isPending={deleteFolderMut.isPending}
      />

      <DeleteConfirmDialog
        open={dlg?.kind === "delete-list"}
        entityType="List"
        entityName={dlg?.kind === "delete-list" ? dlg.name : ""}
        onConfirm={() => {
          if (dlg?.kind !== "delete-list") return;
          deleteListMut.mutate(dlg.listId);
        }}
        onClose={() => setDlg(null)}
        isPending={deleteListMut.isPending}
      />

      <SpaceAppsDialog
        key={dlg?.kind === "space-apps" ? dlg.space.id : "space-apps"}
        open={dlg?.kind === "space-apps"}
        space={dlg?.kind === "space-apps" ? dlg.space : null}
        onClose={() => setDlg(null)}
        onSaved={() =>
          queryClient.invalidateQueries({
            queryKey: ["/api/clickup/workspaces", workspaceId, "spaces"],
          })
        }
      />

      <ListInfoDialog
        key={dlg?.kind === "list-info" ? dlg.list.id : "list-info"}
        open={dlg?.kind === "list-info"}
        list={dlg?.kind === "list-info" ? dlg.list : null}
        onClose={() => setDlg(null)}
        onSaved={invalidateAll}
      />

      {/* ── Template picker dialogs ──────────────────────────────────────── */}

      <TemplatePickerDialog
        open={dlg?.kind === "create-folder-from-template"}
        workspaceId={workspaceId}
        kind="folder"
        title="Create Folder from Template"
        isPending={createFolderFromTemplateMut.isPending}
        materializing={tplMaterializing && createFolderFromTemplateMut.isSuccess}
        onClose={() => {
          setTplMaterializing(false);
          createFolderFromTemplateMut.reset();
          setDlg(null);
        }}
        onConfirm={(templateId, name) => {
          if (dlg?.kind !== "create-folder-from-template") return;
          createFolderFromTemplateMut.mutate({ spaceId: dlg.spaceId, templateId, name });
        }}
      />

      <TemplatePickerDialog
        open={dlg?.kind === "create-list-in-space-from-template"}
        workspaceId={workspaceId}
        kind="list-in-space"
        title="Create List from Template"
        isPending={createListInSpaceFromTemplateMut.isPending}
        materializing={tplMaterializing && createListInSpaceFromTemplateMut.isSuccess}
        onClose={() => {
          setTplMaterializing(false);
          createListInSpaceFromTemplateMut.reset();
          setDlg(null);
        }}
        onConfirm={(templateId, name) => {
          if (dlg?.kind !== "create-list-in-space-from-template") return;
          createListInSpaceFromTemplateMut.mutate({ spaceId: dlg.spaceId, templateId, name });
        }}
      />

      <TemplatePickerDialog
        open={dlg?.kind === "create-list-in-folder-from-template"}
        workspaceId={workspaceId}
        kind="list-in-folder"
        title="Create List from Template"
        isPending={createListInFolderFromTemplateMut.isPending}
        materializing={tplMaterializing && createListInFolderFromTemplateMut.isSuccess}
        onClose={() => {
          setTplMaterializing(false);
          createListInFolderFromTemplateMut.reset();
          setDlg(null);
        }}
        onConfirm={(templateId, name) => {
          if (dlg?.kind !== "create-list-in-folder-from-template") return;
          createListInFolderFromTemplateMut.mutate({
            folderId: dlg.folderId,
            spaceId: dlg.spaceId,
            templateId,
            name,
          });
        }}
      />
    </div>
  );
}

