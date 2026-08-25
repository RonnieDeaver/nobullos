import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { renderContent } from "./helpers";

interface EditHistoryEntry {
  id: string;
  messageId: string;
  editorId: string | null;
  editorName: string | null;
  priorContent: string;
  version: number;
  createdAt: string;
}

interface Props {
  messageId: string;
  channelId: string;
  isAuthor: boolean;
  canRestore: boolean;
  open: boolean;
  onClose: () => void;
  onRestored?: () => void;
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EditHistoryDialog({
  messageId,
  isAuthor: _isAuthor,
  canRestore,
  open,
  onClose,
  onRestored,
}: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: history = [], isLoading } = useQuery<EditHistoryEntry[]>({
    queryKey: [`/api/comms/messages/${messageId}/edit-history`],
    queryFn: () =>
      apiRequest("GET", `/api/comms/messages/${messageId}/edit-history`).then((r) =>
        r.json(),
      ),
    enabled: open,
  });

  const restore = useMutation({
    mutationFn: (historyId: string) =>
      apiRequest("POST", `/api/comms/messages/${messageId}/edit-history/${historyId}/restore`).then(
        (r) => r.json(),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [`/api/comms/messages/${messageId}/edit-history`] }); // fire-and-forget: cache refresh only
      toast({ title: "Message restored" });
      onRestored?.();
      onClose();
    },
    onError: () => {
      toast({ title: "Could not restore", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg" data-testid="edit-history-dialog">
        <DialogHeader>
          <DialogTitle>Edit history</DialogTitle>
        </DialogHeader>
        {isLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isLoading && history.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-6">
            No edits recorded yet.
          </p>
        )}
        {!isLoading && history.length > 0 && (
          <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
            {history.map((entry) => (
              <div
                key={entry.id}
                className="rounded-md border border-border p-3 space-y-1"
                data-testid={`edit-history-entry-${entry.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    v{entry.version} &mdash;{" "}
                    {entry.editorName ?? "Unknown"} &middot;{" "}
                    {formatTs(entry.createdAt)}
                  </span>
                  {canRestore && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs gap-1"
                      onClick={() => restore.mutate(entry.id)}
                      disabled={restore.isPending}
                      data-testid={`restore-version-${entry.id}`}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </Button>
                  )}
                </div>
                <div
                  className="text-sm text-foreground break-words leading-relaxed"
                  data-testid={`edit-history-content-${entry.id}`}
                >
                  {renderContent(entry.priorContent)}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
