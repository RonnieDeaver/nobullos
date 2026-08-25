/**
 * DraftsView — lists all of the current user's saved channel-level drafts.
 * Each row shows the channel name, draft preview, and last-updated time.
 * Clicking a row navigates into the channel (rails + popups wire this via
 * parent). The user can delete a draft from this view without opening it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileText, Trash2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommsContext } from "@/contexts/CommsContext";
import type { CommsDraft } from "./types";
import { stripFormatting } from "./helpers";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function DraftsView({
  onSelectChannel,
}: {
  onSelectChannel: (channelId: string) => void;
}) {
  const qc = useQueryClient();
  const { channels, refetchDrafts } = useCommsContext();

  const { data: drafts = [], isLoading } = useQuery<CommsDraft[]>({
    queryKey: ["/api/comms/drafts"],
    queryFn: () => apiRequest("GET", "/api/comms/drafts").then((r) => r.json()),
    staleTime: 30_000,
  });

  const handleDelete = async (draft: CommsDraft, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await fetch(`/api/comms/channels/${draft.channelId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: "", parentId: draft.parentId ?? null }),
      });
      void qc.invalidateQueries({ queryKey: ["/api/comms/drafts"] }); // fire-and-forget: cache refresh only
      refetchDrafts();
    } catch {
      /* best-effort */
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
        <FileText className="h-6 w-6" />
        <p className="text-sm">No saved drafts</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {drafts.map((draft) => {
        const channel = channels.find((c) => c.id === draft.channelId);
        const channelName = channel?.name ?? channel?.id ?? draft.channelId;

        return (
          <button
            key={draft.id}
            onClick={() => onSelectChannel(draft.channelId)}
            className={cn(
              "w-full flex items-start gap-3 rounded-md px-3 py-2.5 text-left",
              "hover:bg-muted/60 transition-colors group",
            )}
            data-testid={`draft-row-${draft.id}`}
          >
            <FileText className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium truncate">{channelName}</span>
                  {draft.parentId && (
                    <span className="text-xs text-muted-foreground flex-shrink-0 bg-muted px-1 py-0.5 rounded">
                      thread
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {relativeTime(draft.updatedAt)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">{stripFormatting(draft.content)}</p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={(e) => handleDelete(draft, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 flex items-center justify-center rounded hover:bg-red-100 hover:text-red-600 text-muted-foreground"
                  data-testid={`draft-delete-${draft.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Delete draft</TooltipContent>
            </Tooltip>
          </button>
        );
      })}
    </div>
  );
}
