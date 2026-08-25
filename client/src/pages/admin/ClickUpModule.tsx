/**
 * ClickUp admin module — page COMPOSITION ROOT (thin aggregator).
 *
 * This file was a 10,797-line monolith — the largest file in the repo and a
 * proven whole-file merge-conflict hotspot. It was split per the house
 * aggregator pattern (Task #3787): every feature now lives in a per-feature
 * module under client/src/pages/adminClickUp/ (types, lib, customFields,
 * comments, timeTracking, attachments, pickers, hierarchyDialogs, connection,
 * taskDetail, taskList, goals, docs, views, search, spaceTags,
 * hierarchySidebar, chat, peopleSharing), and this file keeps only the page
 * state + tab layout composition.
 *
 * Size is capped by scripts/lint-monolith-aggregator-size.ts. Do NOT add
 * feature code here — put it in the matching client/src/pages/adminClickUp/
 * module (or a new sibling module) and compose it below. See CLICKUP.md for
 * the feature inventory.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/admin/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckSquare,
  Clock,
  FileText,
  LayoutGrid,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Tag,
  Target,
  Unplug,
  Users,
  Hash,
  Shield,
  Globe,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { ClickUpStatus, Space, Workspace } from "@/pages/adminClickUp/types";
import { ListCommentsPanel } from "@/pages/adminClickUp/comments";
import { RunningTimerWidget, TimeReportsPanel } from "@/pages/adminClickUp/timeTracking";
import { ConnectionPanel } from "@/pages/adminClickUp/connection";
import { TaskListPanel } from "@/pages/adminClickUp/taskList";
import { GoalsPanel } from "@/pages/adminClickUp/goals";
import { DocsPanel } from "@/pages/adminClickUp/docs";
import { ViewsPanel } from "@/pages/adminClickUp/views";
import { SearchPanel } from "@/pages/adminClickUp/search";
import { SpaceTagsManager } from "@/pages/adminClickUp/spaceTags";
import { HierarchySidebar } from "@/pages/adminClickUp/hierarchySidebar";
import { ChatPanel } from "@/pages/adminClickUp/chat";
import { AccessPanel, PeoplePanel, SharedPanel } from "@/pages/adminClickUp/peopleSharing";

// ─── Main component ───────────────────────────────────────────────────────────

export default function ClickUpModule() {
  usePageTitle("ClickUp");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedList, setSelectedList] = useState<string | null>(null);
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"tasks" | "goals" | "docs" | "search" | "views" | "tags" | "listcomments" | "chat" | "reports" | "people" | "shared" | "access">("tasks");

  const {
    data: status,
    isLoading: statusLoading,
    refetch: refetchStatus,
  } = useQuery<ClickUpStatus>({
    queryKey: ["/api/integrations/clickup/status"],
    queryFn: () =>
      fetch("/api/integrations/clickup/status", { credentials: "include" }).then((r) => r.json()),
    refetchInterval: 30_000,
  });

  const disconnectMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/integrations/clickup/disconnect", {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/clickup/status"] }); // fire-and-forget: cache refresh only
      toast({ title: "Disconnected from ClickUp" });
    },
    onError: (e: any) =>
      toast({ title: "Disconnect failed", description: e.message, variant: "destructive" }),
  });

  const syncMut = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/clickup/workspaces/${selectedWorkspace}/sync`, {}),
    onSuccess: () => toast({ title: "Sync started" }),
    onError: (e: any) =>
      toast({ title: "Sync failed", description: e.message, variant: "destructive" }),
  });

  const spacesQ = useQuery<{ spaces: Space[] }>({
    queryKey: ["/api/clickup/workspaces", selectedWorkspace, "spaces"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${selectedWorkspace}/spaces`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    enabled: !!selectedWorkspace,
    staleTime: 30_000,
  });
  const spaces = spacesQ.data?.spaces?.filter((s) => !s.archived) ?? [];

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="loading-clickup">
        <Loader2 className="w-6 h-6 animate-spin text-purple-500" />
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div className="p-4 max-w-5xl mx-auto">
        {/* Task #4355 — Pattern-B → shared PageHeader (audit §6.1-B / P1-4). */}
        <PageHeader
          title="ClickUp"
          icon={CheckSquare}
          backHref="/admin/integrations"
          backLabel="Integrations"
          backTestId="button-back-integrations"
          className="mb-6"
        />
        <ConnectionPanel onConnected={() => refetchStatus()} />
      </div>
    );
  }

  const workspaces = status.workspaces ?? [];

  return (
    <div className="p-4 max-w-5xl mx-auto" data-testid="page-clickup-module">
      {/* Task #4355 — Pattern-B → shared PageHeader (audit §6.1-B / P1-4). */}
      <PageHeader
        title="ClickUp"
        icon={CheckSquare}
        backHref="/admin/integrations"
        backLabel="Integrations"
        backTestId="button-back-integrations"
        className="mb-6"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {status.user && (
              <Badge
                variant="outline"
                className="text-xs bg-green-50 text-green-700 border-green-200"
                data-testid="badge-clickup-connected"
              >
                Connected as {status.user.username}
              </Badge>
            )}
            {selectedWorkspace && <RunningTimerWidget workspaceId={selectedWorkspace} />}
            {selectedWorkspace && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending}
                data-testid="button-clickup-sync"
              >
                {syncMut.isPending ? (
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-1" />
                )}
                Sync
              </Button>
            )}
            {/* Task #4357: disconnect kills the integration for everyone until
                re-auth, so it confirms before firing (it sits beside routine
                Sync in this header). */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disconnectMut.isPending}
                  data-testid="button-clickup-disconnect"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  {disconnectMut.isPending ? (
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  ) : (
                    <Unplug className="w-3 h-3 mr-1" />
                  )}
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent data-testid="dialog-confirm-clickup-disconnect">
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect ClickUp?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Removes your stored ClickUp authorization. Task panels,
                    timers, and sync stop working for you until you reconnect
                    and re-authorize from the Integrations page.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-clickup-disconnect-abort">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="button-clickup-disconnect-confirm"
                    onClick={() => disconnectMut.mutate()}
                  >
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      {/* Workspace selector */}
      <div className="mb-4">
        <Label className="text-xs text-gray-500 mb-1 block">Workspace</Label>
        <Select
          value={selectedWorkspace ?? ""}
          onValueChange={(v) => {
            setSelectedWorkspace(v);
            setSelectedSpace(null);
            setSelectedFolder(null);
            setSelectedList(null);
          }}
        >
          <SelectTrigger className="h-8 text-xs w-60" data-testid="select-workspace">
            <SelectValue placeholder="Select workspace…" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((w) => (
              <SelectItem key={w.id} value={w.id} data-testid={`option-workspace-${w.id}`}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!selectedWorkspace ? (
        <div className="flex flex-col items-center justify-center h-64 text-gray-400 gap-2" data-testid="prompt-select-workspace">
          <CheckSquare className="w-8 h-8" />
          <p className="text-sm">Select a workspace to get started</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
          {/* Sidebar */}
          <HierarchySidebar
            workspaceId={selectedWorkspace}
            selectedSpace={selectedSpace}
            selectedFolder={selectedFolder}
            selectedList={selectedList}
            onSelectSpace={(id) => {
              setSelectedSpace(id);
              setSelectedFolder(null);
              setSelectedList(null);
            }}
            onSelectFolder={(id) => {
              setSelectedFolder(id);
              setSelectedList(null);
            }}
            onSelectList={(id, folderId) => {
              setSelectedFolder(folderId);
              setSelectedList(id);
            }}
          />

          {/* Main content */}
          <div>
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
              <TabsList className="text-xs mb-3">
                <TabsTrigger value="tasks" data-testid="tab-tasks">
                  <CheckSquare className="w-3 h-3 mr-1" /> Tasks
                </TabsTrigger>
                <TabsTrigger value="views" data-testid="tab-views">
                  <LayoutGrid className="w-3 h-3 mr-1" /> Views
                </TabsTrigger>
                <TabsTrigger value="search" data-testid="tab-search">
                  <Search className="w-3 h-3 mr-1" /> Search
                </TabsTrigger>
                <TabsTrigger value="goals" data-testid="tab-goals">
                  <Target className="w-3 h-3 mr-1" /> Goals
                </TabsTrigger>
                <TabsTrigger value="docs" data-testid="tab-docs">
                  <FileText className="w-3 h-3 mr-1" /> Docs
                </TabsTrigger>
                <TabsTrigger value="tags" data-testid="tab-tags" disabled={!selectedSpace}>
                  <Tag className="w-3 h-3 mr-1" /> Tags
                </TabsTrigger>
                <TabsTrigger value="listcomments" data-testid="tab-listcomments" disabled={!selectedList}>
                  <MessageSquare className="w-3 h-3 mr-1" /> List Comments
                </TabsTrigger>
                <TabsTrigger value="chat" data-testid="tab-chat">
                  <Hash className="w-3 h-3 mr-1" /> Chat
                </TabsTrigger>
                <TabsTrigger value="reports" data-testid="tab-reports">
                  <Clock className="w-3 h-3 mr-1" /> Time Reports
                </TabsTrigger>
                <TabsTrigger value="access" data-testid="tab-access" disabled={!selectedList}>
                  <Shield className="w-3 h-3 mr-1" /> Access
                </TabsTrigger>
                <TabsTrigger value="people" data-testid="tab-people">
                  <Users className="w-3 h-3 mr-1" /> People
                </TabsTrigger>
                <TabsTrigger value="shared" data-testid="tab-shared">
                  <Globe className="w-3 h-3 mr-1" /> Shared
                </TabsTrigger>
              </TabsList>

              <TabsContent value="tasks">
                {!selectedList ? (
                  <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2" data-testid="prompt-select-list">
                    <CheckSquare className="w-6 h-6" />
                    <p className="text-xs">Select a list from the sidebar to view tasks</p>
                  </div>
                ) : (
                  <TaskListPanel
                    listId={selectedList}
                    workspaceId={selectedWorkspace!}
                    spaceId={selectedSpace}
                  />
                )}
              </TabsContent>

              <TabsContent value="views">
                <ViewsPanel
                  workspaceId={selectedWorkspace!}
                  spaceId={selectedSpace}
                  folderId={selectedFolder}
                  listId={selectedList}
                />
              </TabsContent>

              <TabsContent value="search">
                <SearchPanel workspaceId={selectedWorkspace!} spaces={spaces} />
              </TabsContent>

              <TabsContent value="goals">
                <GoalsPanel workspaceId={selectedWorkspace} />
              </TabsContent>

              <TabsContent value="docs">
                <DocsPanel workspaceId={selectedWorkspace} />
              </TabsContent>

              <TabsContent value="tags">
                {!selectedSpace ? (
                  <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2" data-testid="prompt-select-space-for-tags">
                    <Tag className="w-6 h-6" />
                    <p className="text-xs">Select a space from the sidebar to manage its tags</p>
                  </div>
                ) : (
                  <SpaceTagsManager spaceId={selectedSpace} />
                )}
              </TabsContent>

              <TabsContent value="listcomments" data-testid="panel-listcomments">
                {!selectedList ? (
                  <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2" data-testid="prompt-select-list-for-comments">
                    <MessageSquare className="w-6 h-6" />
                    <p className="text-xs">Select a list from the sidebar to view its comments</p>
                  </div>
                ) : (
                  <ListCommentsPanel listId={selectedList} />
                )}
              </TabsContent>

              <TabsContent value="chat">
                <ChatPanel workspaceId={selectedWorkspace!} />
              </TabsContent>

              <TabsContent value="reports">
                <TimeReportsPanel workspaceId={selectedWorkspace!} />
              </TabsContent>

              <TabsContent value="access" data-testid="panel-access-tab">
                {!selectedList ? (
                  <div className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2" data-testid="prompt-select-list-for-access">
                    <Shield className="w-6 h-6" />
                    <p className="text-xs">Select a list from the sidebar to view its access</p>
                  </div>
                ) : (
                  <AccessPanel
                    type="list"
                    id={selectedList}
                    workspaceId={selectedWorkspace!}
                  />
                )}
              </TabsContent>

              <TabsContent value="people" data-testid="panel-people-tab">
                <PeoplePanel workspaceId={selectedWorkspace!} />
              </TabsContent>

              <TabsContent value="shared" data-testid="panel-shared-tab">
                <SharedPanel workspaceId={selectedWorkspace!} />
              </TabsContent>
            </Tabs>
          </div>
        </div>
      )}
    </div>
  );
}
