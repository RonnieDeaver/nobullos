/**
 * SheetEditor — full-screen Univer spreadsheet editor with debounced autosave,
 * edit-locking, stale-revision detection, and version history/restore.
 *
 * Edit-locking flow:
 *   1. On workbook load: POST /lock to acquire. If someone else holds it →
 *      read-only mode with a "locked by X" banner that polls every 10 s.
 *   2. While holding: POST /lock/heartbeat every 30 s to keep the lock alive.
 *   3. On unmount / beforeunload: DELETE /lock to release.
 *
 * Revision guard:
 *   - The workbook's `revision` counter is sent as `expectedRevision` with every
 *     snapshot PATCH. A 409 means another session saved; we show a toast and
 *     reload to avoid overwriting.
 *
 * - Fetches the workbook snapshot from GET /api/sheets/workbooks/:id.
 *   The response also includes `userPermission` ("owner" | "editor" | "viewer").
 * - Passes the stored IWorkbookData to UniverEditor.
 * - Debounces saves (1 500 ms after the last detected input event inside the
 *   editor area) via PATCH /api/sheets/workbooks/:id.
 * - Shows a save-state badge: idle → saving → saved | error.
 *   Viewers see a "View only" badge instead and autosave is disabled.
 * - Flushes any pending save on page unload (beforeunload) and on wouter
 *   navigation away.
 * - History panel:
 *   - List versions, preview a past snapshot (read-only overlay), restore
 *     (creates a restore-point first so it is undoable), manual "Save version" button.
 * - Mobile (<768 px) mounts a read-only Univer view (Task #4610). Autosave
 *   and edit-lock acquisition stay disabled on phones; vendor bottom bars are
 *   marked as FAB colliders so the floating comms button lifts above them.
 * - Insert Data button opens InsertDataDialog to embed live NoBull data blocks.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { humanizeQueryError } from "@/lib/queryErrorCopy";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Save,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  Lock,
  RefreshCw,
  Database,
  Trash2,
  ChevronDown,
  ChevronUp,
  Download,
  History,
  RotateCcw,
  X,
  BookMarked,
  Activity,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UniverEditorHandle } from "@/components/sheets/UniverEditor";
import { markBottomPinnedVendorColliders } from "@/lib/fabCollider";
import { observeUniverToolbarA11y } from "@/lib/univerToolbarA11y";
import {
  InsertDataDialog,
  type SheetDataBlock,
} from "@/components/sheets/InsertDataDialog";

const UniverEditor = lazy(() => import("@/components/sheets/UniverEditor"));

const AUTOSAVE_DELAY_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const LOCK_POLL_INTERVAL_MS = 10_000;

type SaveState = "idle" | "saving" | "saved" | "error";
type UserPermission = "owner" | "editor" | "viewer";

interface WorkbookLock {
  workbookId: string;
  holderUserId: string;
  holderName: string;
  acquiredAt: string;
  expiresAt: string;
}

interface Workbook {
  id: string;
  name: string;
  snapshot: unknown | null;
  ownerId: string;
  folderId: string | null;
  updatedAt: string;
  revision: number;
}

interface VersionMeta {
  id: string;
  workbookId: string;
  snapshotSizeBytes: number;
  createdBy: string | null;
  label: string | null;
  isRestorePoint: boolean;
  createdAt: string;
}

interface VersionFull extends VersionMeta {
  snapshot: unknown;
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle")
    return (
      <Badge variant="secondary" className="gap-1 text-xs" data-testid="save-badge-idle">
        <Save className="h-3 w-3" />
        Unsaved changes
      </Badge>
    );
  if (state === "saving")
    return (
      <Badge variant="secondary" className="gap-1 text-xs" data-testid="save-badge-saving">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </Badge>
    );
  if (state === "saved")
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-xs text-green-700 dark:text-green-400"
        data-testid="save-badge-saved"
      >
        <CheckCircle2 className="h-3 w-3" />
        Saved
      </Badge>
    );
  return (
    <Badge variant="destructive" className="gap-1 text-xs" data-testid="save-badge-error">
      <AlertCircle className="h-3 w-3" />
      Save failed — retry
    </Badge>
  );
}

// ── Data blocks sidebar ────────────────────────────────────────────────────────

function DataBlocksSidebar({
  workbookId,
  onRefresh,
}: {
  workbookId: string;
  onRefresh?(blockId: string): void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);

  const { data, isLoading } = useQuery<{ blocks: SheetDataBlock[] }>({
    queryKey: [`/api/sheets/workbooks/${workbookId}/blocks`],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchInterval: 10_000,
  });

  const blocks = data?.blocks ?? [];

  const refreshMut = useMutation({
    mutationFn: async (blockId: string) => {
      const res = await apiRequest(
        "POST",
        `/api/sheets/workbooks/${workbookId}/blocks/${blockId}/refresh`,
        {},
      );
      return res.json();
    },
    onSuccess: (_d, blockId) => {
      toast({ title: "Refresh queued", description: "Data will update shortly." });
      void queryClient.invalidateQueries({
        queryKey: [`/api/sheets/workbooks/${workbookId}/blocks`],
      }); // fire-and-forget: cache refresh only
      onRefresh?.(blockId);
    },
    onError: (err: any) => {
      toast({
        title: "Refresh failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (blockId: string) => {
      const res = await apiRequest(
        "DELETE",
        `/api/sheets/workbooks/${workbookId}/blocks/${blockId}`,
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Data block removed" });
      void queryClient.invalidateQueries({
        queryKey: [`/api/sheets/workbooks/${workbookId}/blocks`],
      }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Delete failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading || blocks.length === 0) return null;

  return (
    <aside
      className="shrink-0 border-t bg-muted/30"
      data-testid="data-blocks-sidebar"
    >
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
        onClick={() => setCollapsed((c) => !c)}
        data-testid="btn-toggle-blocks-sidebar"
      >
        <Database className="h-3.5 w-3.5" />
        Live data blocks ({blocks.length})
        {collapsed ? (
          <ChevronUp className="ml-auto h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="ml-auto h-3.5 w-3.5" />
        )}
      </button>

      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto px-4 pb-3" data-testid="blocks-list">
          {blocks.map((block) => (
            <div
              key={block.id}
              className="flex min-w-[160px] flex-col gap-1 rounded-md border bg-background p-2.5 text-xs"
              data-testid={`block-card-${block.id}`}
            >
              <span className="font-medium leading-tight" data-testid={`block-label-${block.id}`}>
                {block.label}
              </span>
              <span className="text-muted-foreground" data-testid={`block-connector-${block.id}`}>
                {block.connectorId.replace(/_/g, " ")}
              </span>
              {block.lastRefreshedAt && (
                <span className="text-muted-foreground" data-testid={`block-refreshed-${block.id}`}>
                  {new Date(block.lastRefreshedAt).toLocaleString()}
                </span>
              )}
              {block.autoRefresh && (
                <Badge variant="secondary" className="w-fit text-caption">
                  Auto-refresh
                </Badge>
              )}
              <div className="mt-1 flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={refreshMut.isPending}
                  onClick={() => refreshMut.mutate(block.id)}
                  data-testid={`btn-refresh-block-${block.id}`}
                  title="Refresh now"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={deleteMut.isPending}
                  onClick={() => deleteMut.mutate(block.id)}
                  data-testid={`btn-delete-block-${block.id}`}
                  title="Remove block"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatVersionDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Main editor ────────────────────────────────────────────────────────────────

function ViewOnlyBadge() {
  return (
    <Badge
      variant="secondary"
      className="gap-1 text-xs text-muted-foreground"
      data-testid="view-only-badge"
    >
      <Eye className="h-3 w-3" />
      View only
    </Badge>
  );
}

function EditorInitErrorCard() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center"
      data-testid="editor-init-error"
      role="alert"
    >
      <AlertCircle className="h-10 w-10 text-destructive" />
      <div>
        <p className="text-sm font-medium">Couldn't load the spreadsheet editor</p>
        <p className="mt-1 text-sm text-muted-foreground">
          The editor failed to start. Reload the page to try again.
        </p>
      </div>
      <Button
        variant="outline"
        onClick={() => window.location.reload()}
        data-testid="button-reload-editor"
      >
        <RefreshCw className="mr-1.5 h-4 w-4" />
        Reload
      </Button>
    </div>
  );
}

export default function SheetEditor() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const editorRef = useRef<UniverEditorHandle>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<boolean>(false);
  const saveStateRef = useRef<SaveState>("saved");
  const revisionRef = useRef<number>(0);
  const holdingLockRef = useRef<boolean>(false);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [saveState, _setSaveState] = useState<SaveState>("saved");
  const [lockHolder, setLockHolder] = useState<WorkbookLock | null>(null);
  const [lockAcquired, setLockAcquired] = useState<boolean | null>(null); // null = not yet attempted
  // Phones get a read-only view instead of the full editor (see render below).
  // This must stay a JS breakpoint — it gates WHICH Univer mount happens
  // (read-only vs editable) and blocks lock acquisition, which CSS show/hide
  // cannot do — but it rides the CSS media-query engine (matchMedia flip)
  // rather than per-pixel resize events. Audit P2-9 (§4.4), Task #4610.
  const isMobile = useIsMobile();
  const mobileEditorWrapRef = useRef<HTMLDivElement>(null);

  // ── Vendor toolbar accessible names (Task #4707) ───────────────────────────
  // Univer's ribbon buttons are icon-only with no accessible name (same
  // vendor gap the doc editor fixed in Task #4680). Attach the bounded
  // labeling pass, keyed on Univer's own `data-u-command` ids, to whichever
  // editor wrapper is mounted (desktop editable / mobile read-only / preview
  // remounts — the callback ref re-fires on every mount). See
  // client/src/lib/univerToolbarA11y.ts.
  const toolbarA11yCleanupRef = useRef<(() => void) | null>(null);
  const editorA11yRef = useCallback((el: HTMLDivElement | null) => {
    toolbarA11yCleanupRef.current?.();
    toolbarA11yCleanupRef.current = el ? observeUniverToolbarA11y(el) : null;
  }, []);
  useEffect(
    () => () => {
      toolbarA11yCleanupRef.current?.();
      toolbarA11yCleanupRef.current = null;
    },
    [],
  );
  // Latest-value mirror so an in-flight lock acquisition can detect a
  // desktop→phone flip that happened after the request left (see acquireLock).
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  // Insert data dialog state
  const [insertDataOpen, setInsertDataOpen] = useState(false);

  // Univer engine init failure — the wrapper's init throw is otherwise only
  // logged, leaving a blank editor. Surface a visible error card + Reload.
  const [editorInitError, setEditorInitError] = useState(false);

  // ── History panel state ────────────────────────────────────────────────────
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<VersionFull | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);

  // ── Activity panel state ───────────────────────────────────────────────────
  const [activityOpen, setActivityOpen] = useState(false);

  // ── Activity query (fetched lazily when the panel opens) ──────────────────
  interface ActivityEntry {
    id: string;
    actorName: string | null;
    action: string;
    detail: Record<string, unknown> | null;
    occurredAt: string;
  }
  const { data: activityData, isLoading: activityLoading, refetch: refetchActivity } = useQuery<{
    activity: ActivityEntry[];
  }>({
    queryKey: [`/api/sheets/workbooks/${id}/activity`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!id && activityOpen,
    staleTime: 30_000,
  });
  const activityEntries = activityData?.activity ?? [];

  function formatActivityDate(iso: string) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function formatAction(action: string) {
    const labels: Record<string, string> = {
      created: "Created",
      renamed: "Renamed",
      edited: "Edited",
      shared: "Shared",
      unshared: "Unshared",
      imported: "Imported",
      exported: "Downloaded",
      version_saved: "Version saved",
      restored: "Restored",
      duplicated: "Duplicated",
    };
    return labels[action] ?? action;
  }

  function setSaveState(s: SaveState) {
    saveStateRef.current = s;
    _setSaveState(s);
  }

  // ── Fetch workbook ─────────────────────────────────────────────────────────
  const {
    data: workbookData,
    isLoading,
    isError,
    error,
    refetch: refetchWorkbook,
  } = useQuery<{ workbook: Workbook; userPermission: UserPermission }>({
    queryKey: [`/api/sheets/workbooks/${id}`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!id,
  });

  const workbook = workbookData?.workbook;
  const userPermission: UserPermission = workbookData?.userPermission ?? "viewer";
  const isViewerOnly = userPermission === "viewer";

  // Keep revisionRef in sync with what the server last told us.
  useEffect(() => {
    if (workbook) {
      revisionRef.current = workbook.revision;
    }
  }, [workbook]);

  // ── Lock helpers ───────────────────────────────────────────────────────────

  const acquireLock = useCallback(async (displayName: string) => {
    if (!id) return;
    try {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${id}/lock`, {
        holderName: displayName,
      });
      const data = await res.json();
      if (isMobileRef.current) {
        // The viewport flipped to phone width while the request was in
        // flight — phones never hold the edit lock, and lockAcquired must
        // stay null so neither the heartbeat nor the 10s lock-poll timers
        // ever start on the phone (Task #4610). Any lock we did win is
        // released immediately.
        holdingLockRef.current = false;
        setLockAcquired(null);
        setLockHolder(null);
        if (data.acquired) {
          try {
            await apiRequest("DELETE", `/api/sheets/workbooks/${id}/lock`);
          } catch {
            // Best-effort; server-side TTL will clean up anyway.
          }
        }
        return;
      }
      if (data.acquired) {
        holdingLockRef.current = true;
        setLockAcquired(true);
        setLockHolder(null);
      } else {
        holdingLockRef.current = false;
        setLockAcquired(false);
        setLockHolder(data.lock ?? null);
      }
    } catch {
      // Non-fatal: default to read-only if we can't reach the lock endpoint.
      // On a mid-flight flip to phone width, stay in the null (never
      // attempted) state instead so no lock polling starts on mobile.
      holdingLockRef.current = false;
      setLockAcquired(isMobileRef.current ? null : false);
    }
  }, [id]);

  const sendHeartbeat = useCallback(async () => {
    if (!id || !holdingLockRef.current) return;
    try {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${id}/lock/heartbeat`, {});
      if (!res.ok) {
        // Lock was lost (409) — drop to read-only.
        holdingLockRef.current = false;
        setLockAcquired(false);
        toast({
          title: "Edit lock expired",
          description: "Your edit session timed out. Reload to regain editing access.",
          variant: "destructive",
        });
      }
    } catch {
      // Heartbeat failures are non-fatal; next tick will retry.
    }
  }, [id, toast]);

  const releaseLock = useCallback(async () => {
    if (!id || !holdingLockRef.current) return;
    holdingLockRef.current = false;
    try {
      await apiRequest("DELETE", `/api/sheets/workbooks/${id}/lock`);
    } catch {
      // Best-effort; server-side TTL will clean up anyway.
    }
  }, [id]);

  const pollLockStatus = useCallback(async () => {
    if (!id || holdingLockRef.current) return;
    try {
      const res = await apiRequest("GET", `/api/sheets/workbooks/${id}/lock`);
      const data = await res.json();
      if (!data.locked) {
        // Lock is free — stop polling so user knows they can try.
        setLockHolder(null);
        if (lockPollTimerRef.current) {
          clearInterval(lockPollTimerRef.current);
          lockPollTimerRef.current = null;
        }
      } else {
        setLockHolder(data.lock ?? null);
      }
    } catch {
      // Non-fatal.
    }
  }, [id]);

  // ── Acquire lock once workbook is loaded ───────────────────────────────────
  useEffect(() => {
    if (!workbook || !user) return;
    if (isMobile) {
      // Phones are strictly read-only (Task #4610): never acquire the edit
      // lock. If we were holding one (desktop → phone resize), release it.
      if (holdingLockRef.current) void releaseLock(); // fire-and-forget: errors handled internally
      holdingLockRef.current = false;
      setLockAcquired(null);
      setLockHolder(null);
      return;
    }
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.email ||
      user.id;
    void acquireLock(displayName); // fire-and-forget: errors handled internally (defaults to read-only)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbook?.id, user?.id, isMobile]);

  // ── Start heartbeat when we hold the lock ─────────────────────────────────
  useEffect(() => {
    if (lockAcquired !== true) {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
      return;
    }
    heartbeatTimerRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
  }, [lockAcquired, sendHeartbeat]);

  // ── Start lock polling when we're in read-only mode ───────────────────────
  useEffect(() => {
    if (lockAcquired !== false) {
      if (lockPollTimerRef.current) {
        clearInterval(lockPollTimerRef.current);
        lockPollTimerRef.current = null;
      }
      return;
    }
    lockPollTimerRef.current = setInterval(pollLockStatus, LOCK_POLL_INTERVAL_MS);
    return () => {
      if (lockPollTimerRef.current) clearInterval(lockPollTimerRef.current);
    };
  }, [lockAcquired, pollLockStatus]);

  // ── Release lock on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      if (lockPollTimerRef.current) clearInterval(lockPollTimerRef.current);
      void releaseLock(); // fire-and-forget: best-effort cleanup, errors handled internally
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch version list (only when panel is open) ───────────────────────────
  const {
    data: versionsData,
    isLoading: versionsLoading,
    refetch: refetchVersions,
  } = useQuery<{ versions: VersionMeta[] }>({
    queryKey: [`/api/sheets/workbooks/${id}/versions`],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!id && historyOpen,
    staleTime: 10_000,
  });

  const versions = versionsData?.versions ?? [];

  // ── Save mutation ──────────────────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async (snapshot: unknown) => {
      const res = await apiRequest("PATCH", `/api/sheets/workbooks/${id}`, {
        snapshot,
        expectedRevision: revisionRef.current,
      });
      if (res.status === 423) {
        const data = await res.json();
        throw Object.assign(new Error("LOCK_REQUIRED"), { code: "LOCK_REQUIRED", lock: data.lock });
      }
      if (res.status === 409) {
        const data = await res.json();
        throw Object.assign(new Error("REVISION_CONFLICT"), {
          code: "REVISION_CONFLICT",
          currentRevision: data.currentRevision,
        });
      }
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      return res.json();
    },
    onMutate: () => {
      setSaveState("saving");
    },
    onSuccess: (data) => {
      setSaveState("saved");
      pendingSaveRef.current = false;
      if (data.workbook?.revision !== undefined) {
        revisionRef.current = data.workbook.revision;
      }
      // Update the cache with the returned workbook so the name etc. stay fresh.
      queryClient.setQueryData([`/api/sheets/workbooks/${id}`], {
        workbook: data.workbook,
        userPermission,
      });
    },
    onError: (err: any) => {
      setSaveState("error");
      pendingSaveRef.current = false;

      if (err?.code === "LOCK_REQUIRED") {
        toast({
          title: "Edit lock lost",
          description: "Another user is now editing this workbook. Your changes were not saved.",
          variant: "destructive",
        });
        holdingLockRef.current = false;
        setLockAcquired(false);
        setLockHolder(err.lock ?? null);
        return;
      }

      if (err?.code === "REVISION_CONFLICT") {
        toast({
          title: "Workbook changed",
          description:
            "This workbook was saved by another session. Reloading to prevent data loss.",
          variant: "destructive",
        });
        // Reload workbook to get the latest revision.
        void queryClient.invalidateQueries({ queryKey: [`/api/sheets/workbooks/${id}`] }); // fire-and-forget: cache refresh only
        return;
      }

      toast({
        title: "Autosave failed",
        description: err?.message ?? "Could not save. Click the error badge to retry.",
        variant: "destructive",
      });
    },
  });

  // ── Core save function ─────────────────────────────────────────────────────
  const doSave = useCallback(() => {
    if (isViewerOnly || !holdingLockRef.current || previewVersion) return;
    const snapshot = editorRef.current?.getSnapshot();
    if (snapshot === null || snapshot === undefined) return;
    saveMutation.mutate(snapshot);
  }, [saveMutation, isViewerOnly, previewVersion]);

  // ── Debounced save trigger — disabled for viewers ──────────────────────────
  const triggerDebounce = useCallback(() => {
    if (isViewerOnly || !holdingLockRef.current || previewVersion) return;
    if (!pendingSaveRef.current) {
      pendingSaveRef.current = true;
      setSaveState("idle");
    }
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      doSave();
    }, AUTOSAVE_DELAY_MS);
  }, [doSave, isViewerOnly, previewVersion]);

  // ── Retry on error badge click ─────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    if (isViewerOnly) return;
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    doSave();
  }, [doSave, isViewerOnly]);

  // ── Flush on unload ────────────────────────────────────────────────────────
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isViewerOnly || !holdingLockRef.current || !pendingSaveRef.current) return;
      // Flush synchronously is best-effort (fetch may not complete).
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      const snapshot = editorRef.current?.getSnapshot();
      if (snapshot) {
        navigator.sendBeacon?.(`/api/sheets/workbooks/${id}`);
      }
      e.preventDefault();
      e.returnValue = "You have unsaved changes. Leave anyway?";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [id, isViewerOnly]);

  // ── Flush on wouter navigation ─────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (!isViewerOnly && pendingSaveRef.current && saveStateRef.current !== "saving") {
        doSave();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Manual "Save version" ──────────────────────────────────────────────────
  const handleSaveVersion = useCallback(async () => {
    const snapshot = editorRef.current?.getSnapshot();
    if (!snapshot) {
      toast({ title: "Nothing to save", description: "The editor has no data yet.", variant: "destructive" });
      return;
    }
    setSavingVersion(true);
    try {
      const res = await apiRequest("POST", `/api/sheets/workbooks/${id}/versions`, {
        snapshot,
        label: null,
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to save version");
      toast({ title: "Version saved", description: "A snapshot of the current state was captured." });
      void refetchVersions(); // fire-and-forget: background refetch only
    } catch (err: any) {
      toast({ title: "Save version failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setSavingVersion(false);
    }
  }, [id, toast, refetchVersions]);

  // ── Preview a historical version ───────────────────────────────────────────
  const handlePreviewVersion = useCallback(async (versionId: string) => {
    setPreviewLoading(true);
    try {
      const res = await apiRequest("GET", `/api/sheets/workbooks/${id}/versions/${versionId}`);
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to load version");
      const data = await res.json();
      setPreviewVersion(data.version as VersionFull);
    } catch (err: any) {
      toast({ title: "Could not load version", description: err?.message, variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  }, [id, toast]);

  // ── Exit preview (back to current) ────────────────────────────────────────
  const handleExitPreview = useCallback(() => {
    setPreviewVersion(null);
  }, []);

  // ── Restore a version ─────────────────────────────────────────────────────
  const handleRestore = useCallback(async (versionId: string) => {
    setRestoringVersionId(versionId);
    try {
      const res = await apiRequest(
        "POST",
        `/api/sheets/workbooks/${id}/versions/${versionId}/restore`,
      );
      if (!res.ok) throw new Error((await res.json())?.error ?? "Failed to restore");
      const data = await res.json();
      // Update cache with restored workbook so editor reloads the right snapshot.
      queryClient.setQueryData([`/api/sheets/workbooks/${id}`], { workbook: data.workbook });
      setPreviewVersion(null);
      setHistoryOpen(false);
      toast({ title: "Version restored", description: "The workbook has been restored. A restore-point was saved first." });
      void refetchVersions(); // fire-and-forget: background refetch only
    } catch (err: any) {
      toast({ title: "Restore failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setRestoringVersionId(null);
    }
  }, [id, toast, queryClient, refetchVersions]);

  // ── Loading / error guards ─────────────────────────────────────────────────
  if (!user) return null;

  if (isLoading) {
    return (
      <div className="flex h-[calc(100dvh-var(--nav-height))] items-center justify-center" data-testid="sheet-editor-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !workbook) {
    const humanized = humanizeQueryError(error, { kind: "query" });
    return (
      <div
        className="flex h-[calc(100dvh-var(--nav-height))] flex-col items-center justify-center gap-4 px-4 text-center"
        data-testid="sheet-editor-error"
        role="status"
      >
        <AlertCircle className="h-10 w-10 text-destructive" />
        <div>
          <p className="text-sm font-medium">
            {isError ? humanized.title : "Couldn't load this workbook"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {isError ? humanized.description : "It may have been moved or deleted. Retry."}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => void refetchWorkbook()}
            data-testid="button-retry-workbook"
          >
            <RefreshCw className="mr-1.5 h-4 w-4" />
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => setLocation("/sheets")}
            data-testid="button-back-to-sheets"
          >
            Back to Sheets
          </Button>
        </div>
      </div>
    );
  }

  // ── Mobile read-only view (Task #4610) ────────────────────────────────────
  // Phones mount Univer in read-only mode: no autosave wiring, no edit lock
  // (the acquire effect above bails on isMobile). Vendor bottom bars (sheet
  // tabs / status bar) get marked as FAB colliders once Univer is ready so
  // the floating comms button lifts above them.
  if (isMobile) {
    return (
      <div
        className="flex h-[calc(100dvh-var(--nav-height))] flex-col overflow-hidden"
        data-testid="sheet-editor-mobile-view"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLocation("/sheets")}
            aria-label="Back to Sheets"
            data-testid="btn-back-to-sheets"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            data-testid="workbook-name"
          >
            {workbook.name}
          </span>
          <ViewOnlyBadge />
        </header>
        <p
          className="shrink-0 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="mobile-readonly-note"
        >
          Read-only on phones — open on a 768&nbsp;px+ screen to edit.
        </p>
        <div
          ref={(el) => {
            mobileEditorWrapRef.current = el;
            editorA11yRef(el);
          }}
          className="relative min-h-0 flex-1"
        >
          {editorInitError ? (
            <EditorInitErrorCard />
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <UniverEditor
                key={`mobile-${workbook.id}`}
                initialData={workbook.snapshot}
                readOnly
                onError={() => setEditorInitError(true)}
                onReady={() =>
                  markBottomPinnedVendorColliders(mobileEditorWrapRef.current)
                }
              />
            </Suspense>
          )}
        </div>
      </div>
    );
  }

  const isReadOnly = isViewerOnly || lockAcquired === false;

  // Derive the active sheet ID from the Univer snapshot (first sheet or
  // fallback). The InsertDataDialog needs this to know which sheet to target.
  const firstSheetId = (() => {
    try {
      const snap = workbook.snapshot as any;
      const sheets = snap?.sheets;
      if (sheets) {
        const sheetOrder: string[] = snap.sheetOrder ?? Object.keys(sheets);
        return sheetOrder[0] ?? "sheet1";
      }
    } catch {}
    return "sheet1";
  })();

  // ── Determine which snapshot to load in the editor ─────────────────────────
  // When previewing a version we remount the editor with the version snapshot
  // (key changes) and block all autosave triggers.
  const editorKey = previewVersion ? `preview-${previewVersion.id}` : `current-${workbook.id}`;
  const editorSnapshot = previewVersion ? previewVersion.snapshot : workbook.snapshot;

  // ── Full editor ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-[calc(100dvh-var(--nav-height))] flex-col overflow-hidden" data-testid="sheet-editor-root">
      {/* Locked-by-another banner */}
      {isReadOnly && lockHolder && (
        <div
          className="flex flex-wrap items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200 border-b border-amber-200"
          data-testid="lock-banner"
        >
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            <strong>{lockHolder.holderName}</strong> is currently editing this workbook.
            You are in read-only mode.
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1 text-amber-800 hover:text-amber-900 dark:text-amber-200"
            onClick={pollLockStatus}
            data-testid="btn-check-lock"
          >
            <RefreshCw className="h-3 w-3" />
            Check again
          </Button>
        </div>
      )}

      {/* Lock freed — invite user to reload */}
      {isReadOnly && !lockHolder && lockAcquired !== null && (
        <div
          className="flex flex-wrap items-center gap-2 bg-green-50 px-4 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200 border-b border-green-200"
          data-testid="lock-free-banner"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>The workbook is now free. Reload the page to start editing.</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1 text-green-800 dark:text-green-200"
            onClick={() => window.location.reload()}
            data-testid="btn-reload-to-edit"
          >
            <RefreshCw className="h-3 w-3" />
            Reload
          </Button>
        </div>
      )}

      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 overflow-x-auto border-b bg-background px-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/sheets")}
          data-testid="btn-back-to-sheets"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Sheets
        </Button>

        <span className="text-sm font-medium whitespace-nowrap" data-testid="workbook-name">
          {workbook.name}
        </span>

        {isReadOnly && (
          <ViewOnlyBadge />
        )}

        {(lockAcquired === false) && (
          <Badge variant="outline" className="gap-1 text-xs" data-testid="badge-readonly">
            <Lock className="h-3 w-3" />
            Locked
          </Badge>
        )}

        {/* Insert Data button */}
        <Button
          variant="outline"
          size="sm"
          className="ml-2 gap-1.5"
          onClick={() => setInsertDataOpen(true)}
          data-testid="btn-insert-data"
        >
          <Database className="h-3.5 w-3.5" />
          Insert data
        </Button>

        {/* Download button */}
        {(() => {
          const snap = workbook.snapshot as any;
          const sheetOrder: string[] = snap?.sheetOrder ?? [];
          const sheets: Record<string, { name?: string }> = snap?.sheets ?? {};
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-1 gap-1.5"
                  data-testid="btn-download-menu"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = `/api/sheets/workbooks/${id}/export/xlsx`;
                    a.download = `${workbook.name}.xlsx`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                  }}
                  data-testid="menu-download-xlsx"
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download as Excel (.xlsx)
                </DropdownMenuItem>
                {sheetOrder.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <div
                      className="px-2 py-1.5 text-xs text-muted-foreground max-w-[260px]"
                      data-testid="text-csv-formatting-hint"
                    >
                      CSV contains values only — formatting is kept in Excel
                      downloads
                    </div>
                    {sheetOrder.map((sheetId) => {
                      const sheetName = sheets[sheetId]?.name || sheetId;
                      return (
                        <DropdownMenuItem
                          key={sheetId}
                          onClick={() => {
                            const a = document.createElement("a");
                            a.href = `/api/sheets/workbooks/${id}/sheets/${encodeURIComponent(sheetId)}/export/csv`;
                            a.download = `${workbook.name} - ${sheetName}.csv`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                          }}
                          data-testid={`menu-download-csv-${sheetId}`}
                        >
                          Download "{sheetName}" as CSV
                        </DropdownMenuItem>
                      );
                    })}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })()}

        <div className="ml-auto flex items-center gap-2">
          {/* Save version button */}
          {!previewVersion && !isReadOnly && holdingLockRef.current && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveVersion}
              disabled={savingVersion}
              data-testid="btn-save-version"
            >
              {savingVersion ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : (
                <BookMarked className="mr-2 h-3 w-3" />
              )}
              Save version
            </Button>
          )}

          {/* History toggle */}
          <Button
            variant={historyOpen ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              setHistoryOpen((v) => !v);
              if (!historyOpen) void refetchVersions(); // fire-and-forget: background refetch only
            }}
            data-testid="btn-toggle-history"
          >
            <History className="mr-2 h-3 w-3" />
            History
          </Button>

          {/* Activity toggle */}
          <Button
            variant={activityOpen ? "secondary" : "outline"}
            size="sm"
            onClick={() => {
              setActivityOpen((v) => !v);
              if (!activityOpen) void refetchActivity(); // fire-and-forget: background refetch only
            }}
            data-testid="btn-toggle-activity"
          >
            <Activity className="mr-2 h-3 w-3" />
            Activity
          </Button>

          {/* Save state badge */}
          {!previewVersion && !isReadOnly && (
            saveState === "error" ? (
              <button onClick={handleRetry} data-testid="btn-retry-save">
                <SaveIndicator state={saveState} />
              </button>
            ) : (
              <SaveIndicator state={saveState} />
            )
          )}
        </div>
      </header>

      {/* Preview mode banner */}
      {previewVersion && (
        <div
          className="flex flex-wrap items-center gap-3 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-900/30"
          data-testid="version-preview-banner"
        >
          <span className="font-medium text-amber-800 dark:text-amber-200">
            Previewing version from {formatVersionDate(previewVersion.createdAt)}
            {previewVersion.label ? ` — "${previewVersion.label}"` : ""}
          </span>
          <span className="text-amber-700 dark:text-amber-300 text-xs">
            (read-only)
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleRestore(previewVersion.id)}
              disabled={restoringVersionId === previewVersion.id}
              data-testid="btn-restore-previewed-version"
            >
              {restoringVersionId === previewVersion.id ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-3 w-3" />
              )}
              Restore this version
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExitPreview}
              data-testid="btn-exit-preview"
            >
              <X className="mr-2 h-3 w-3" />
              Back to current
            </Button>
          </div>
        </div>
      )}

      {/* Main content: editor + optional history sidebar */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Editor area — pointer/keyboard events trigger debounce (no-op for viewers or during preview) */}
        <div
          ref={editorA11yRef}
          className="min-h-0 flex-1 relative"
          onPointerDown={isReadOnly || !holdingLockRef.current || previewVersion ? undefined : triggerDebounce}
          onKeyDown={isReadOnly || !holdingLockRef.current || previewVersion ? undefined : triggerDebounce}
          data-testid="sheet-editor-area"
        >
          {editorInitError ? (
            <EditorInitErrorCard />
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              }
            >
              <UniverEditor
                key={editorKey}
                ref={editorRef}
                initialData={editorSnapshot}
                readOnly={isReadOnly || !holdingLockRef.current || !!previewVersion}
                onError={() => setEditorInitError(true)}
                onReady={() => {
                  // Univer is ready; mark as saved if not in preview (initial load is not a change).
                  if (!previewVersion && !isReadOnly && holdingLockRef.current) setSaveState("saved");
                }}
              />
            </Suspense>
          )}

          {/* Read-only overlay in preview mode */}
          {previewVersion && (
            <div
              className="pointer-events-auto absolute inset-0 z-[var(--z-sticky)]"
              data-testid="preview-readonly-overlay"
            />
          )}
        </div>

        {/* Activity sidebar */}
        {activityOpen && (
          <aside
            className="w-72 shrink-0 overflow-y-auto border-l bg-background"
            data-testid="activity-panel"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="text-sm font-semibold">Activity</span>
              <button
                onClick={() => setActivityOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                data-testid="btn-close-activity"
                aria-label="Close activity panel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {activityLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : activityEntries.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No activity recorded yet.
              </p>
            ) : (
              <ul className="divide-y" data-testid="activity-list">
                {activityEntries.map((entry) => (
                  <li
                    key={entry.id}
                    className="px-4 py-3 text-sm hover:bg-muted/40 transition-colors"
                    data-testid={`activity-item-${entry.id}`}
                  >
                    <p className="font-medium text-xs text-foreground">
                      {formatAction(entry.action)}
                    </p>
                    {entry.actorName && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        by {entry.actorName}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatActivityDate(entry.occurredAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}

        {/* History sidebar */}
        {historyOpen && (
          <aside
            className="w-72 shrink-0 overflow-y-auto border-l bg-background"
            data-testid="version-history-panel"
          >
            <div className="flex items-center justify-between border-b px-4 py-3">
              <span className="text-sm font-semibold">Version history</span>
              <button
                onClick={() => setHistoryOpen(false)}
                className="text-muted-foreground hover:text-foreground"
                data-testid="btn-close-history"
                aria-label="Close history panel"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {versionsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : versions.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                No versions saved yet. Click "Save version" to capture the current state.
              </p>
            ) : (
              <ul className="divide-y" data-testid="version-list">
                {versions.map((v) => {
                  const isCurrentPreview = previewVersion?.id === v.id;
                  return (
                    <li
                      key={v.id}
                      className={`px-4 py-3 text-sm transition-colors ${
                        isCurrentPreview ? "bg-amber-50 dark:bg-amber-900/20" : "hover:bg-muted/40"
                      }`}
                      data-testid={`version-item-${v.id}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-xs">
                            {formatVersionDate(v.createdAt)}
                          </p>
                          {v.label && (
                            <p className="truncate text-xs text-muted-foreground mt-0.5">
                              {v.label}
                            </p>
                          )}
                          {v.isRestorePoint && (
                            <Badge variant="secondary" className="mt-1 text-xs px-1 py-0">
                              Restore point
                            </Badge>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatBytes(v.snapshotSizeBytes)}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handlePreviewVersion(v.id)}
                            disabled={previewLoading || isCurrentPreview}
                            data-testid={`btn-preview-version-${v.id}`}
                          >
                            {previewLoading && !isCurrentPreview ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Preview"
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => handleRestore(v.id)}
                            disabled={restoringVersionId !== null}
                            data-testid={`btn-restore-version-${v.id}`}
                          >
                            {restoringVersionId === v.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "Restore"
                            )}
                          </Button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        )}
      </div>

      {/* Live data blocks sidebar (shown when blocks exist) */}
      {id && (
        <DataBlocksSidebar
          workbookId={id}
          onRefresh={() => {
            // After a refresh is enqueued, trigger a workbook re-fetch after a
            // short delay so the updated snapshot comes in.
            setTimeout(() => {
              void queryClient.invalidateQueries({
                queryKey: [`/api/sheets/workbooks/${id}`],
              }); // fire-and-forget: cache refresh only
            }, 3_000);
          }}
        />
      )}

      {/* Insert Data dialog */}
      {id && (
        <InsertDataDialog
          open={insertDataOpen}
          onOpenChange={setInsertDataOpen}
          workbookId={id}
          sheetId={firstSheetId}
          onBlockCreated={() => {
            // After creating a block, trigger a workbook re-fetch after a short
            // delay so the freshly-populated region appears in the editor.
            setTimeout(() => {
              void queryClient.invalidateQueries({
                queryKey: [`/api/sheets/workbooks/${id}`],
              }); // fire-and-forget: cache refresh only
            }, 4_000);
          }}
        />
      )}
    </div>
  );
}
