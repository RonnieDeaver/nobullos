// Rate Limits admin — notification + pending-digest retention editors and their edit history.
// Extracted VERBATIM from the former 5.9k-line RateLimitUsers.tsx monolith
// (house aggregator pattern, cf. ClickUpModule / Task #3787; this split:
// F11C / Task #4159). The page composition root is
// client/src/pages/admin/RateLimitUsers.tsx — new rate-limit admin UI
// belongs here (or in a new sibling module), never in the aggregator.

import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Clock, History, Trash2, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { useTabVisibility } from "@/hooks/use-tab-visibility";
import { format } from "date-fns";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { useToast } from "@/hooks/use-toast";

type RetentionStats = {
  totalRows: number;
  oldestAttemptedAt?: number | null;
  newestAttemptedAt?: number | null;
  oldestQueuedAt?: number | null;
  newestQueuedAt?: number | null;
  overdueRows: number;
};

type NotificationRetentionData = {
  retentionDays: number;
  configuredRetentionDays: number | null;
  defaultRetentionDays: number;
  fallbackRetentionDays: number;
  maxRetentionDays: number;
  lastEdited?: LastEditedInfo;
  stats?: RetentionStats;
  preview?: { retentionDays: number; overdueRows: number } | null;
};

type PendingDigestRetentionData = NotificationRetentionData;

type PendingDigestRetentionHistoryEntry = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  oldValues: { retentionDays: number | null } | null;
  newValues: { retentionDays: number | null } | null;
  changedAt: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
};


export function NotificationRetentionEditor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isTabVisible = useTabVisibility();
  const { data, isLoading, error } = useQuery<NotificationRetentionData>({
    queryKey: ["/api/health/rate-limits/notification-retention"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/notification-retention", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch notification retention");
      return res.json();
    },
    // Keep the "oldest entry / total stored" stats in sync with the
    // notification history list, which auto-refetches every 30s while the
    // tab is visible (#660).
    refetchInterval: isTabVisible ? 30000 : false,
    refetchIntervalInBackground: false,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmShorten, setConfirmShorten] = useState<{
    days: number;
    overdue: number;
  } | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);

  const startEdit = () => {
    setDraft(
      data?.configuredRetentionDays != null
        ? String(data.configuredRetentionDays)
        : String(data?.retentionDays ?? ""),
    );
    setDraftError(null);
    setEditing(true);
  };

  const mutation = useMutation({
    meta: { silent: true },
    mutationFn: async (retentionDays: number | null) => {
      const res = await fetch("/api/health/rate-limits/notification-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ retentionDays }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to update retention");
      return json;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/notification-retention"],
      }); // fire-and-forget: cache refresh only
      setEditing(false);
      toast?.({
        title: "Retention updated",
        description: "New value will be used on the next scheduled prune.",
      });
    },
    onError: (err: Error) => {
      setDraftError(err.message);
    },
  });

  // Live preview of how many rows the proposed retention would prune. We
  // refetch with `previewDays` so admins see the impact before saving and can
  // confirm shortening operations (#660).
  const previewQuery = useQuery<NotificationRetentionData>({
    queryKey: [
      "/api/health/rate-limits/notification-retention",
      "preview",
      editing ? draft : "",
    ],
    enabled: editing && /^\d+$/.test(draft.trim()),
    queryFn: async () => {
      const days = Number(draft.trim());
      const res = await fetch(
        `/api/health/rate-limits/notification-retention?previewDays=${days}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch preview");
      return res.json();
    },
  });

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraftError(null);
      mutation.mutate(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1) {
      setDraftError("Enter a positive whole number of days.");
      return;
    }
    if (data && n > data.maxRetentionDays) {
      setDraftError(`Maximum is ${data.maxRetentionDays} days.`);
      return;
    }
    const previewOverdue = previewQuery.data?.preview?.overdueRows ?? 0;
    const currentEffective = data?.retentionDays ?? 0;
    if (n < currentEffective && previewOverdue > 0) {
      setConfirmShorten({ days: n, overdue: previewOverdue });
      return;
    }
    setDraftError(null);
    mutation.mutate(n);
  };

  const [lastPrune, setLastPrune] = useState<{
    deleted: number;
    retentionDays: number;
    cutoffMs: number;
    at: number;
  } | null>(null);
  const pruneMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        "/api/health/rate-limits/notification-retention/prune",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to prune");
      return json as { deleted: number; retentionDays: number; cutoffMs: number };
    },
    onSuccess: (json) => {
      setLastPrune({ ...json, at: Date.now() });
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/notification-retention"],
      }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/notifications"],
      }); // fire-and-forget: cache refresh only
      toast?.({
        title: "Cleanup complete",
        description: `Deleted ${json.deleted.toLocaleString()} notification${json.deleted === 1 ? "" : "s"} older than ${json.retentionDays} day${json.retentionDays === 1 ? "" : "s"}.`,
      });
    },
    onError: (err: Error) => {
      toast?.({
        title: "Cleanup failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handlePruneNow = () => {
    setConfirmPrune(true);
  };

  const stats = data?.stats;
  const oldest = stats?.oldestAttemptedAt ?? null;
  const total = stats?.totalRows ?? 0;
  const overdue = stats?.overdueRows ?? 0;

  const pruneOverdue = data?.stats?.overdueRows ?? 0;
  const pruneRetentionDays = data?.retentionDays ?? 0;

  return (
    <>
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground border-t border-primary/10 pt-3 mt-3"
      data-testid="row-notification-retention"
    >
      <Clock className="w-3.5 h-3.5 text-primary" />
      <span className="text-muted-foreground">History retention:</span>
      {isLoading ? (
        <span data-testid="text-notification-retention-loading">Loading…</span>
      ) : error ? (
        <span className="text-red-600 dark:text-red-300" data-testid="text-notification-retention-error">
          Failed to load
        </span>
      ) : editing ? (
        <>
          <Input
            type="number"
            min={1}
            max={data?.maxRetentionDays ?? 3650}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={String(data?.fallbackRetentionDays ?? 30)}
            aria-label="Notification history retention (days)"
            className="h-7 w-24 text-xs"
            data-testid="input-notification-retention-days"
          />
          <span className="text-muted-foreground">days</span>
          <Button
            size="sm"
            className="h-7 text-xs px-2"
            disabled={mutation.isPending}
            onClick={handleSave}
            data-testid="button-save-notification-retention"
          >
            Save
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => {
              setEditing(false);
              setDraftError(null);
            }}
            data-testid="button-cancel-notification-retention"
          >
            Cancel
          </Button>
          <button
            type="button"
            className="text-primary-ink hover:underline"
            onClick={() => {
              setDraft("");
              setDraftError(null);
            }}
            data-testid="button-reset-notification-retention"
          >
            Reset to default ({data?.fallbackRetentionDays ?? 30}d)
          </button>
          {previewQuery.data?.preview && (
            <span
              className="text-muted-foreground"
              data-testid="text-notification-retention-preview"
            >
              ≈ {previewQuery.data.preview.overdueRows.toLocaleString()} row
              {previewQuery.data.preview.overdueRows === 1 ? "" : "s"} would be pruned
            </span>
          )}
          {draftError && (
            <span className="text-red-600 dark:text-red-300" data-testid="text-notification-retention-save-error">
              {draftError}
            </span>
          )}
        </>
      ) : (
        <>
          <span
            className="font-medium text-foreground"
            data-testid="text-notification-retention-days"
          >
            {data?.retentionDays ?? "—"} days
          </span>
          {data && data.configuredRetentionDays == null && (
            <Badge variant="outline" className="text-xs py-0">
              default
            </Badge>
          )}
          <button
            type="button"
            className="text-primary-ink hover:underline"
            onClick={startEdit}
            data-testid="button-edit-notification-retention"
          >
            Change
          </button>
          <span className="text-muted-foreground">
            Older entries are pruned nightly. New value takes effect on the next run.
          </span>
          {stats && (
            <span
              className="text-muted-foreground"
              data-testid="text-notification-retention-stats"
            >
              · {total.toLocaleString()} stored
              {oldest
                ? `, oldest ${format(new Date(oldest), "MMM d, yyyy")}`
                : ""}
              {overdue > 0
                ? `, ${overdue.toLocaleString()} overdue`
                : ""}
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-xs px-2 ml-1"
            onClick={handlePruneNow}
            disabled={pruneMutation.isPending}
            data-testid="button-prune-notification-retention"
          >
            <Trash2 className="w-3 h-3 mr-1" />
            {pruneMutation.isPending ? "Cleaning…" : "Run cleanup now"}
          </Button>
          {data?.lastEdited && (
            <LastEditedBadge
              info={data.lastEdited}
              testId="text-last-edited-notification-retention"
            />
          )}
          {lastPrune && (
            <span
              className="basis-full text-xs text-muted-foreground"
              data-testid="text-notification-retention-prune-result"
            >
              Last cleanup: deleted{" "}
              <span className="font-medium">
                {lastPrune.deleted.toLocaleString()}
              </span>{" "}
              row{lastPrune.deleted === 1 ? "" : "s"} older than{" "}
              {format(new Date(lastPrune.cutoffMs), "MMM d, yyyy h:mm a")} (
              {lastPrune.retentionDays}d retention).
            </span>
          )}
        </>
      )}
    </div>
    <AlertDialog
      open={confirmShorten !== null}
      onOpenChange={(open) => !open && setConfirmShorten(null)}
    >
      <AlertDialogContent data-testid="dialog-confirm-shorten-notification-retention">
        <AlertDialogHeader>
          <AlertDialogTitle>Shorten notification retention?</AlertDialogTitle>
          <AlertDialogDescription data-testid="text-confirm-shorten-notification-retention-warning">
            {confirmShorten
              ? `Shortening retention to ${confirmShorten.days} day${confirmShorten.days === 1 ? "" : "s"} will make ${confirmShorten.overdue.toLocaleString()} stored notification${confirmShorten.overdue === 1 ? "" : "s"} eligible for the next prune.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-shorten-notification-retention">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-shorten-notification-retention"
            onClick={() => {
              if (!confirmShorten) return;
              const days = confirmShorten.days;
              setConfirmShorten(null);
              setDraftError(null);
              mutation.mutate(days);
            }}
          >
            Shorten retention
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={confirmPrune} onOpenChange={setConfirmPrune}>
      <AlertDialogContent data-testid="dialog-confirm-prune-notification-retention">
        <AlertDialogHeader>
          <AlertDialogTitle>Run notification cleanup now?</AlertDialogTitle>
          <AlertDialogDescription data-testid="text-confirm-prune-notification-retention-warning">
            {pruneOverdue > 0
              ? `This will permanently delete ${pruneOverdue.toLocaleString()} notification${pruneOverdue === 1 ? "" : "s"} older than ${pruneRetentionDays} day${pruneRetentionDays === 1 ? "" : "s"}. Deleted rows cannot be recovered.`
              : "No rows currently exceed the retention window, but this will still execute the prune."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-prune-notification-retention">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-prune-notification-retention"
            onClick={() => {
              setConfirmPrune(false);
              pruneMutation.mutate();
            }}
          >
            Run cleanup
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <NotificationRetentionHistory refetchKey={lastPrune?.at ?? 0} />
    </>
  );
}

type NotificationRetentionHistoryItem = {
  id: string;
  ranAtMs: number;
  triggeredBy: string;
  actor: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  actorId: string | null;
  retentionDays: number;
  cutoffMs: number;
  deletedRows: number;
  durationMs: number;
  status: string;
  errorMessage: string | null;
};

function describeActor(item: NotificationRetentionHistoryItem): string {
  const trigger = item.triggeredBy;
  if (trigger === "scheduler") return "Scheduler (nightly cron)";
  if (trigger === "startup") return "Scheduler (startup)";
  if (item.actor) {
    const name = [item.actor.firstName, item.actor.lastName]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(" ")
      .trim();
    if (name) return name;
    if (item.actor.email) return item.actor.email;
  }
  if (item.actorId) return item.actorId;
  return trigger;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m ${rem}s`;
}

function NotificationRetentionHistory({ refetchKey }: { refetchKey: number }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery<{
    items: NotificationRetentionHistoryItem[];
  }>({
    queryKey: ["/api/health/rate-limits/notification-retention/history"],
    queryFn: async () => {
      const res = await fetch(
        "/api/health/rate-limits/notification-retention/history?limit=10",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch cleanup history");
      return res.json();
    },
  });

  // Bump refetch whenever an on-demand prune just completed so the row
  // shows up immediately without waiting for the page to reload.
  useEffect(() => {
    if (refetchKey > 0) {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/notification-retention/history"],
      }); // fire-and-forget: cache refresh only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetchKey]);

  const items = data?.items ?? [];

  return (
    <div
      className="basis-full mt-2 border-t border-primary/10 pt-2"
      data-testid="section-notification-retention-history"
    >
      <div className="text-xs font-medium text-foreground mb-1">
        Recent cleanups
      </div>
      {isLoading ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-notification-retention-history-loading"
        >
          Loading…
        </div>
      ) : error ? (
        <div
          className="text-xs text-red-600 dark:text-red-300"
          data-testid="text-notification-retention-history-error"
        >
          Failed to load cleanup history
        </div>
      ) : items.length === 0 ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid="text-notification-retention-history-empty"
        >
          No cleanups recorded yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="w-full text-xs"
            data-testid="table-notification-retention-history"
          >
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal py-1 pr-3">When</th>
                <th className="text-left font-normal py-1 pr-3">Triggered by</th>
                <th className="text-right font-normal py-1 pr-3">Retention</th>
                <th className="text-right font-normal py-1 pr-3">Cutoff</th>
                <th className="text-right font-normal py-1 pr-3">Deleted</th>
                <th className="text-right font-normal py-1 pr-3">Duration</th>
                <th className="text-left font-normal py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="border-t border-primary/5"
                  data-testid={`row-notification-retention-history-${item.id}`}
                >
                  <td className="py-1 pr-3 whitespace-nowrap">
                    {format(new Date(item.ranAtMs), "MMM d, yyyy h:mm a")}
                  </td>
                  <td
                    className="py-1 pr-3"
                    data-testid={`text-history-actor-${item.id}`}
                  >
                    {describeActor(item)}
                  </td>
                  <td className="py-1 pr-3 text-right">
                    {item.retentionDays}d
                  </td>
                  <td className="py-1 pr-3 text-right whitespace-nowrap">
                    {format(new Date(item.cutoffMs), "MMM d, yyyy")}
                  </td>
                  <td
                    className="py-1 pr-3 text-right tabular-nums"
                    data-testid={`text-history-deleted-${item.id}`}
                  >
                    {item.deletedRows.toLocaleString()}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {formatDuration(item.durationMs)}
                  </td>
                  <td className="py-1">
                    {item.status === "ok" ? (
                      <span className="text-green-700 dark:text-green-300">ok</span>
                    ) : (
                      <span
                        className="text-red-600 dark:text-red-300"
                        title={item.errorMessage ?? undefined}
                      >
                        {item.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function PendingDigestRetentionEditor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isTabVisible = useTabVisibility();
  const { data, isLoading, error } = useQuery<PendingDigestRetentionData>({
    queryKey: ["/api/health/rate-limits/pending-digest-retention"],
    queryFn: async () => {
      const res = await fetch("/api/health/rate-limits/pending-digest-retention", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch pending digest retention");
      return res.json();
    },
    // Keep the "oldest queued entry / total stored" stats in sync with the
    // queued-digest list shown on the dashboard, which polls digest-status
    // every 15s while the tab is visible (#1116).
    refetchInterval: isTabVisible ? 15000 : false,
    refetchIntervalInBackground: false,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmShorten, setConfirmShorten] = useState<{
    days: number;
    overdue: number;
  } | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const historyQuery = useQuery<{ history: PendingDigestRetentionHistoryEntry[] }>({
    queryKey: ["/api/health/rate-limits/pending-digest-retention/history"],
    queryFn: async () => {
      const res = await fetch(
        "/api/health/rate-limits/pending-digest-retention/history",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json();
    },
    enabled: historyOpen,
  });

  const startEdit = () => {
    setDraft(
      data?.configuredRetentionDays != null
        ? String(data.configuredRetentionDays)
        : String(data?.retentionDays ?? ""),
    );
    setDraftError(null);
    setEditing(true);
  };

  const previewQuery = useQuery<PendingDigestRetentionData>({
    queryKey: [
      "/api/health/rate-limits/pending-digest-retention",
      "preview",
      editing ? draft : "",
    ],
    enabled: editing && /^\d+$/.test(draft.trim()),
    queryFn: async () => {
      const days = Number(draft.trim());
      const res = await fetch(
        `/api/health/rate-limits/pending-digest-retention?previewDays=${days}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to fetch preview");
      return res.json();
    },
  });

  const mutation = useMutation({
    meta: { silent: true },
    mutationFn: async (retentionDays: number | null) => {
      const res = await fetch("/api/health/rate-limits/pending-digest-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ retentionDays }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to update retention");
      return json;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/pending-digest-retention"],
      }); // fire-and-forget: cache refresh only
      setEditing(false);
      toast?.({
        title: "Retention updated",
        description:
          "New value will be used on the next pending-digest cleanup run.",
      });
    },
    onError: (err: Error) => {
      setDraftError(err.message);
    },
  });

  const pruneMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        "/api/health/rate-limits/pending-digest-retention/prune",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to prune");
      return json as { deleted: number; retentionDays: number };
    },
    onSuccess: (json) => {
      void queryClient.invalidateQueries({
        queryKey: ["/api/health/rate-limits/pending-digest-retention"],
      }); // fire-and-forget: cache refresh only
      toast?.({
        title: "Cleanup complete",
        description: `Deleted ${json.deleted.toLocaleString()} pending alert${json.deleted === 1 ? "" : "s"} older than ${json.retentionDays} day${json.retentionDays === 1 ? "" : "s"}.`,
      });
    },
    onError: (err: Error) => {
      toast?.({
        title: "Cleanup failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleSave = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraftError(null);
      mutation.mutate(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1) {
      setDraftError("Enter a positive whole number of days.");
      return;
    }
    if (data && n > data.maxRetentionDays) {
      setDraftError(`Maximum is ${data.maxRetentionDays} days.`);
      return;
    }
    const previewOverdue = previewQuery.data?.preview?.overdueRows ?? 0;
    const currentEffective = data?.retentionDays ?? 0;
    if (n < currentEffective && previewOverdue > 0) {
      setConfirmShorten({ days: n, overdue: previewOverdue });
      return;
    }
    setDraftError(null);
    mutation.mutate(n);
  };

  const handlePruneNow = () => {
    setConfirmPrune(true);
  };

  const stats = data?.stats;
  const oldest = stats?.oldestQueuedAt ?? null;
  const total = stats?.totalRows ?? 0;
  const overdueCount = stats?.overdueRows ?? 0;

  const pruneRetentionDays = data?.retentionDays ?? 0;

  return (
    <>
    <Card data-testid="card-pending-digest-retention">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Layers className="w-4 h-4" />
          Pending Digest Retention
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          How long queued warnings are kept between digest flushes before
          being dropped.
        </p>
      </CardHeader>
      <CardContent>
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid="row-pending-digest-retention"
        >
          <Clock className="w-3.5 h-3.5 text-primary" />
          <span className="text-muted-foreground">Queue retention:</span>
          {isLoading ? (
            <span data-testid="text-pending-digest-retention-loading">Loading…</span>
          ) : error ? (
            <span
              className="text-red-600 dark:text-red-300"
              data-testid="text-pending-digest-retention-error"
            >
              Failed to load
            </span>
          ) : editing ? (
            <>
              <Input
                type="number"
                min={1}
                max={data?.maxRetentionDays ?? 365}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={String(data?.fallbackRetentionDays ?? 7)}
                aria-label="Pending-digest retention (days)"
                className="h-7 w-24 text-xs"
                data-testid="input-pending-digest-retention-days"
              />
              <span className="text-muted-foreground">days</span>
              <Button
                size="sm"
                className="h-7 text-xs px-2"
                disabled={mutation.isPending}
                onClick={handleSave}
                data-testid="button-save-pending-digest-retention"
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => {
                  setEditing(false);
                  setDraftError(null);
                }}
                data-testid="button-cancel-pending-digest-retention"
              >
                Cancel
              </Button>
              <button
                type="button"
                className="text-primary-ink hover:underline"
                onClick={() => {
                  setDraft("");
                  setDraftError(null);
                }}
                data-testid="button-reset-pending-digest-retention"
              >
                Reset to default ({data?.fallbackRetentionDays ?? 7}d)
              </button>
              {previewQuery.data?.preview && (
                <span
                  className="text-muted-foreground"
                  data-testid="text-pending-digest-retention-preview"
                >
                  ≈ {previewQuery.data.preview.overdueRows.toLocaleString()} row
                  {previewQuery.data.preview.overdueRows === 1 ? "" : "s"} would be pruned
                </span>
              )}
              {draftError && (
                <span
                  className="text-red-600 dark:text-red-300"
                  data-testid="text-pending-digest-retention-save-error"
                >
                  {draftError}
                </span>
              )}
            </>
          ) : (
            <>
              <span
                className="font-medium text-foreground"
                data-testid="text-pending-digest-retention-days"
              >
                {data?.retentionDays ?? "—"} days
              </span>
              {data && data.configuredRetentionDays == null && (
                <Badge variant="outline" className="text-xs py-0">
                  default
                </Badge>
              )}
              <button
                type="button"
                className="text-primary-ink hover:underline"
                onClick={startEdit}
                data-testid="button-edit-pending-digest-retention"
              >
                Change
              </button>
              {stats && (
                <span
                  className="text-muted-foreground"
                  data-testid="text-pending-digest-retention-stats"
                >
                  · {total.toLocaleString()} queued
                  {oldest
                    ? `, oldest ${format(new Date(oldest), "MMM d, yyyy")}`
                    : ""}
                  {overdueCount > 0
                    ? `, ${overdueCount.toLocaleString()} overdue`
                    : ""}
                </span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 text-xs px-2 ml-1"
                onClick={handlePruneNow}
                disabled={pruneMutation.isPending}
                data-testid="button-prune-pending-digest-retention"
              >
                <Trash2 className="w-3 h-3 mr-1" />
                {pruneMutation.isPending ? "Cleaning…" : "Run cleanup now"}
              </Button>
              {data?.lastEdited && (
                <LastEditedBadge
                  info={data.lastEdited}
                  testId="text-last-edited-pending-digest-retention"
                />
              )}
              <button
                type="button"
                className="text-primary-ink hover:underline inline-flex items-center gap-1"
                onClick={() => setHistoryOpen(true)}
                data-testid="button-view-history-pending-digest-retention"
              >
                <History className="w-3 h-3" />
                View history
              </button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
    <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent
        className="max-w-2xl"
        data-testid="dialog-pending-digest-retention-history"
      >
        <DialogHeader>
          <DialogTitle>Pending digest retention — recent changes</DialogTitle>
          <DialogDescription>
            Last 20 changes to the queued-warning retention window.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {historyQuery.isLoading ? (
            <div
              className="text-xs text-muted-foreground py-6 text-center"
              data-testid="text-pending-digest-retention-history-loading"
            >
              Loading…
            </div>
          ) : historyQuery.error ? (
            <div
              className="text-xs text-red-600 dark:text-red-300 py-6 text-center"
              data-testid="text-pending-digest-retention-history-error"
            >
              Failed to load history.
            </div>
          ) : !historyQuery.data?.history?.length ? (
            <div
              className="text-xs text-muted-foreground py-6 text-center"
              data-testid="text-pending-digest-retention-history-empty"
            >
              No changes recorded yet.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b">
                <tr>
                  <th className="text-left font-normal py-2 pr-3">When</th>
                  <th className="text-left font-normal py-2 pr-3">Editor</th>
                  <th className="text-left font-normal py-2 pr-3">Change</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.history.map((entry) => {
                  const oldDays = entry.oldValues?.retentionDays;
                  const newDays = entry.newValues?.retentionDays;
                  const fmtDays = (d: number | null | undefined) =>
                    d == null ? "default" : `${d}d`;
                  const editor = formatEditorAttribution(entry, "Unknown");
                  return (
                    <tr
                      key={entry.id}
                      className="border-b last:border-0"
                      data-testid={`row-pending-digest-retention-history-${entry.id}`}
                    >
                      <td className="py-2 pr-3 align-top">
                        {entry.changedAt
                          ? format(new Date(entry.changedAt), "MMM d, yyyy h:mm a")
                          : "—"}
                      </td>
                      <td
                        className="py-2 pr-3 align-top"
                        data-testid={`text-pending-digest-retention-history-editor-${entry.id}`}
                      >
                        {editor}
                      </td>
                      <td
                        className="py-2 pr-3 align-top font-mono"
                        data-testid={`text-pending-digest-retention-history-change-${entry.id}`}
                      >
                        {fmtDays(oldDays)} → {fmtDays(newDays)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog
      open={confirmShorten !== null}
      onOpenChange={(open) => !open && setConfirmShorten(null)}
    >
      <AlertDialogContent data-testid="dialog-confirm-shorten-pending-digest-retention">
        <AlertDialogHeader>
          <AlertDialogTitle>Shorten pending-digest retention?</AlertDialogTitle>
          <AlertDialogDescription data-testid="text-confirm-shorten-pending-digest-retention-warning">
            {confirmShorten
              ? `Shortening retention to ${confirmShorten.days} day${confirmShorten.days === 1 ? "" : "s"} will make ${confirmShorten.overdue.toLocaleString()} pending alert${confirmShorten.overdue === 1 ? "" : "s"} eligible for the next prune.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-shorten-pending-digest-retention">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-shorten-pending-digest-retention"
            onClick={() => {
              if (!confirmShorten) return;
              const days = confirmShorten.days;
              setConfirmShorten(null);
              setDraftError(null);
              mutation.mutate(days);
            }}
          >
            Shorten retention
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={confirmPrune} onOpenChange={setConfirmPrune}>
      <AlertDialogContent data-testid="dialog-confirm-prune-pending-digest-retention">
        <AlertDialogHeader>
          <AlertDialogTitle>Run pending-digest cleanup now?</AlertDialogTitle>
          <AlertDialogDescription data-testid="text-confirm-prune-pending-digest-retention-warning">
            {overdueCount > 0
              ? `This will permanently delete ${overdueCount.toLocaleString()} pending alert${overdueCount === 1 ? "" : "s"} older than ${pruneRetentionDays} day${pruneRetentionDays === 1 ? "" : "s"}. Deleted rows cannot be recovered.`
              : "No rows currently exceed the retention window, but this will still execute the prune."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-prune-pending-digest-retention">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-prune-pending-digest-retention"
            onClick={() => {
              setConfirmPrune(false);
              pruneMutation.mutate();
            }}
          >
            Run cleanup
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
