import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { CommsChannel } from "./types";
import { channelDisplayName, ChannelIcon, renderContent } from "./helpers";

interface Props {
  messageId: string;
  messagePreview: string;
  open: boolean;
  onClose: () => void;
  onForwarded?: (channelId: string) => void;
}

export function ForwardDialog({
  messageId,
  messagePreview,
  open,
  onClose,
  onForwarded,
}: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [comment, setComment] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  const { data: channels = [] } = useQuery<CommsChannel[]>({
    queryKey: ["/api/comms/channels"],
    queryFn: () => apiRequest("GET", "/api/comms/channels").then((r) => r.json()),
    enabled: open,
    staleTime: 30000,
  });

  const forward = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/comms/messages/${messageId}/forward`, {
        targetChannelId: selectedChannelId,
        comment: comment.trim() || undefined,
      }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
      const ch = channels.find((c) => c.id === selectedChannelId);
      toast({ title: `Forwarded to ${ch ? channelDisplayName(ch) : "channel"}` });
      setComment("");
      setSelectedChannelId(null);
      if (selectedChannelId) onForwarded?.(selectedChannelId);
      onClose();
    },
    onError: (err: any) => {
      toast({
        title: err?.message ?? "Could not forward message",
        variant: "destructive",
      });
    },
  });

  const selectedChannel = channels.find((c) => c.id === selectedChannelId) ?? null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm" data-testid="forward-dialog">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/30 p-2 text-sm text-muted-foreground line-clamp-3">
            {messagePreview ? renderContent(messagePreview) : "(empty message)"}
          </div>

          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">
              Forward to channel
            </Label>
            {selectedChannel ? (
              <div className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
                <div className="flex items-center gap-1.5 text-sm">
                  <ChannelIcon ch={selectedChannel} />
                  <span>{channelDisplayName(selectedChannel)}</span>
                </div>
                <button
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setSelectedChannelId(null)}
                  data-testid="forward-clear-channel"
                >
                  Change
                </button>
              </div>
            ) : (
              <Command className="rounded border border-border">
                <CommandInput placeholder="Search channels…" data-testid="forward-channel-search" />
                <CommandList className="max-h-40">
                  <CommandEmpty>No channels found.</CommandEmpty>
                  <CommandGroup>
                    {channels.map((ch) => (
                      <CommandItem
                        key={ch.id}
                        value={channelDisplayName(ch)}
                        onSelect={() => setSelectedChannelId(ch.id)}
                        data-testid={`forward-channel-option-${ch.id}`}
                      >
                        <span className="mr-2 text-muted-foreground">
                          <ChannelIcon ch={ch} />
                        </span>
                        {channelDisplayName(ch)}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            )}
          </div>

          <div>
            <Label className="text-xs text-muted-foreground mb-1 block">
              Add a comment (optional)
            </Label>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add context…"
              className="text-sm"
              data-testid="forward-comment-input"
            />
          </div>

          <Button
            className="w-full text-sm"
            onClick={() => forward.mutate()}
            disabled={!selectedChannelId || forward.isPending}
            data-testid="forward-submit"
          >
            {forward.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Forward
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
