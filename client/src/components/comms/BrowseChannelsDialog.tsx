/**
 * NoBull Comms page — browse channels dialog.
 * Extracted verbatim from client/src/pages/Comms.tsx (Task #3787 split).
 * Discover/join public channels.
 */

import { useQuery } from "@tanstack/react-query";
import { channelDisplayName } from "@/components/comms/helpers";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Hash } from "lucide-react";
import { type CommsChannel } from "./pageTypes";

// ─── Discover public channels dialog ─────────────────────────────────────────

export function BrowseChannelsDialog({
  open,
  onClose,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onJoined: (channelId: string) => void;
}) {
  const { data: channels = [] } = useQuery<CommsChannel[]>({
    queryKey: ["/api/comms/channels/public"],
    queryFn: () => apiRequest("GET", "/api/comms/channels/public").then((r) => r.json()),
    enabled: open,
  });

  const join = async (id: string) => {
    await apiRequest("POST", `/api/comms/channels/${id}/join`);
    onJoined(id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Browse channels</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {channels.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center justify-between p-2 rounded border border-border hover:bg-muted/30"
              data-testid={`browse-channel-${ch.id}`}
            >
              <div>
                <div className="flex items-center gap-1 text-sm font-medium">
                  <Hash className="h-4 w-4" />
                  {channelDisplayName(ch)}
                </div>
                {ch.topic && <div className="text-xs text-muted-foreground">{ch.topic}</div>}
              </div>
              <Button size="sm" variant="outline" onClick={() => join(ch.id)}>
                Join
              </Button>
            </div>
          ))}
          {channels.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No public channels yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
