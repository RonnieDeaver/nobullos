import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin/PageHeader";
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

interface AppBackupRun {
  id: string;
  kind: "scheduled" | "manual";
  status: "in_progress" | "success" | "partial" | "failed";
  dbStatus: string | null;
  filesStatus: string | null;
  dbDumpKey: string | null;
  fileManifestKey: string | null;
  dbDumpSizeBytes: number | null;
  fileObjectCount: number | null;
  fileCopiedCount: number | null;
  fileTotalSizeBytes: number | null;
  totalSizeBytes: number | null;
  errorMessage: string | null;
  triggeredBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function statusVariant(
  status: AppBackupRun["status"],
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "success":
      return "default";
    case "partial":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

export default function BackupsConsole() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isCeo = !!user && user.role === "ceo";

  const { data, isLoading, error } = useQuery<{ runs: AppBackupRun[] }>({
    queryKey: ["/api/admin/backups"],
    enabled: isCeo,
    refetchInterval: 30_000,
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backups/run");
      return res.json();
    },
    onSuccess: (result: { status?: string }) => {
      toast({
        title: "Backup finished",
        description: `Status: ${result?.status ?? "unknown"}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/backups"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Backup failed to run",
        description: err?.message ?? String(err),
        variant: "destructive",
      });
    },
  });

  if (authLoading) {
    return <div data-testid="status-loading">Loading…</div>;
  }

  if (!isCeo) {
    return (
      <div className="container mx-auto py-6" data-testid="status-forbidden">
        <Card>
          <CardHeader>
            <CardTitle>Forbidden</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              This page is restricted to the CEO role.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const runs = data?.runs ?? [];

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-backups">
      {/* Task #4355 — shared Pattern-A header; Backups previously shipped no
          back affordance at all (audit §6.1-B / P1-4). */}
      <PageHeader
        title="App Backups"
        backHref="/"
        backLabel="Dashboard"
        subtitle="Daily Postgres dump + Object Storage file manifest, saved to private Object Storage and retained indefinitely."
        actions={
          /* Task #4357: not destructive, but a heavyweight production
             operation (full pg_dump + file manifest against the live DB) —
             the confirm keeps a stray click from kicking one off. */
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                disabled={runMutation.isPending}
                data-testid="button-run-backup"
              >
                {runMutation.isPending ? "Running…" : "Run backup now"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent data-testid="dialog-confirm-run-backup">
              <AlertDialogHeader>
                <AlertDialogTitle>Run a full backup now?</AlertDialogTitle>
                <AlertDialogDescription>
                  Dumps the entire production database and enumerates Object
                  Storage into a new backup snapshot. This adds real load while
                  it runs and can take a while — the daily job already covers
                  routine coverage.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-run-backup-abort">
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="button-run-backup-confirm"
                  onClick={() => runMutation.mutate()}
                >
                  Run backup
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      />

      {isLoading && <div data-testid="status-loading">Loading…</div>}
      {error && (
        <div data-testid="status-error" className="text-sm text-destructive">
          Failed to load backups: {(error as any)?.message ?? String(error)}
        </div>
      )}

      {!isLoading && runs.length === 0 && (
        <Card>
          <CardContent className="py-8">
            <p
              className="text-sm text-muted-foreground text-center"
              data-testid="text-empty"
            >
              No backups yet. The daily job runs in the deployment, or press
              “Run backup now”.
            </p>
          </CardContent>
        </Card>
      )}

      {runs.map((run) => (
        <Card key={run.id} data-testid={`card-backup-${run.id}`}>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Badge
                variant={statusVariant(run.status)}
                data-testid={`status-backup-${run.id}`}
              >
                {run.status}
              </Badge>
              <span className="text-sm font-normal text-muted-foreground">
                {run.kind}
              </span>
              <span
                className="text-sm font-normal"
                data-testid={`text-started-${run.id}`}
              >
                {formatDate(run.startedAt)}
              </span>
            </CardTitle>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!run.dbDumpKey}
                onClick={() =>
                  window.open(
                    `/api/admin/backups/${run.id}/download/db`,
                    "_blank",
                  )
                }
                data-testid={`button-download-db-${run.id}`}
              >
                DB dump
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!run.fileManifestKey}
                onClick={() =>
                  window.open(
                    `/api/admin/backups/${run.id}/download/manifest`,
                    "_blank",
                  )
                }
                data-testid={`button-download-manifest-${run.id}`}
              >
                File manifest
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">DB dump</div>
                <div data-testid={`text-db-status-${run.id}`}>
                  {run.dbStatus ?? "—"} · {formatBytes(run.dbDumpSizeBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Files</div>
                <div data-testid={`text-files-status-${run.id}`}>
                  {run.filesStatus ?? "—"} ·{" "}
                  {run.fileObjectCount ?? 0} objs ({run.fileCopiedCount ?? 0} new)
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Total size</div>
                <div data-testid={`text-total-size-${run.id}`}>
                  {formatBytes(run.totalSizeBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Finished</div>
                <div data-testid={`text-finished-${run.id}`}>
                  {formatDate(run.finishedAt)}
                </div>
              </div>
            </div>
            {run.errorMessage && (
              <div
                className="mt-3 text-xs text-destructive whitespace-pre-wrap break-words"
                data-testid={`text-error-${run.id}`}
              >
                {run.errorMessage}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
