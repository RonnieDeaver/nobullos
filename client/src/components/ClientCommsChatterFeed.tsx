import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useAuth } from "@/hooks/use-auth";
import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send, ExternalLink, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { apiRequest } from "@/lib/queryClient";

interface ChatterMessage {
  id: string;
  channelId: string;
  userId: string | null;
  content: string;
  contentType: "text" | "system";
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  } | null;
  reactionCounts: Record<string, number>;
  replyCount: number;
}

interface ClientCommsChatterFeedProps {
  clientId: string;
  clientName: string;
}

function userDisplayName(user: ChatterMessage["user"] | null): string {
  if (!user) return "System";
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : user.id.slice(0, 8);
}

function userInitials(user: ChatterMessage["user"] | null): string {
  if (!user) return "?";
  if (user.firstName) return user.firstName[0].toUpperCase();
  if (user.lastName) return user.lastName[0].toUpperCase();
  return "?";
}

export default function ClientCommsChatterFeed({ clientId, clientName }: ClientCommsChatterFeedProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: messages = [], isLoading } = useQuery<ChatterMessage[]>({
    queryKey: [`/api/clients/${clientId}/comms-feed`],
    queryFn: () =>
      apiRequest("GET", `/api/clients/${clientId}/comms-feed?limit=50`).then((r) => r.json()),
    refetchInterval: 30000,
    staleTime: 15000,
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() });
  }, [messages.length]);

  const { data: myChannels = [] } = useQuery<{ id: string; name: string; clientId: string | null }[]>({
    queryKey: ["/api/comms/channels"],
    queryFn: () => apiRequest("GET", "/api/comms/channels").then((r) => r.json()),
    staleTime: 60000,
  });

  const clientChannel = myChannels.find((c) => c.clientId === clientId);

  const sendMutation = useMutation({
    mutationFn: async (content: string) => {
      let channelId = clientChannel?.id;
      if (!channelId) {
        // Server-side find-or-create: returns the client's existing channel
        // (adding us as a member if needed) or creates it — never 409s.
        const ch = await apiRequest("POST", `/api/clients/${clientId}/comms-channel`, {
          name: `client-${(clientName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40) || "unknown"}`,
        }).then((r) => r.json());
        channelId = ch.id;
      }
      return apiRequest("POST", `/api/comms/channels/${channelId}/messages`, {
        content,
        contentType: "text",
      });
    },
    onSuccess: () => {
      setDraft("");
      void qc.invalidateQueries({ queryKey: [`/api/clients/${clientId}/comms-feed`] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/comms/channels"] }); // fire-and-forget: cache refresh only
    },
  });

  const handleSend = () => {
    const trimmed = draft.trim();
    if (!trimmed || sendMutation.isPending) return;
    sendMutation.mutate(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  const visibleMessages = messages.filter((m) => !m.deletedAt);

  return (
    <Card className="bg-card border-border" data-testid="card-client-comms-chatter">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-foreground flex items-center gap-2 text-base">
            <MessageSquare className="w-4 h-4" />
            Team Chat
            {visibleMessages.length > 0 && (
              <Badge className="bg-primary/10 text-primary text-xs">{visibleMessages.length}</Badge>
            )}
          </CardTitle>
          <Link href="/comms">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs border-primary/20 text-primary-ink gap-1"
              data-testid="button-open-full-comms"
            >
              <ExternalLink className="w-3 h-3" />
              Open Team Chat
            </Button>
          </Link>
        </div>
        {clientChannel && (
          <p className="text-xs text-muted-foreground/80">#{clientChannel.name}</p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        <div
          className="h-72 overflow-y-auto space-y-2 pr-1"
          data-testid="comms-chatter-message-list"
        >
          {isLoading && (
            <div className="flex justify-center items-center h-20">
              <Loader2 className="w-4 h-4 animate-spin text-primary/40" />
            </div>
          )}
          {!isLoading && visibleMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-20 text-center">
              <MessageSquare className="w-6 h-6 text-primary/20 mb-1" />
              <p className="text-xs text-muted-foreground/80">No team messages yet for this client.</p>
              <p className="text-xs text-muted-foreground/60">Send one below or tag a client in Team Chat.</p>
            </div>
          )}
          {visibleMessages.map((msg) => (
            <div key={msg.id} className="flex gap-2 group" data-testid={`chatter-msg-${msg.id}`}>
              {msg.user?.profileImageUrl ? (
                <img
                  src={msg.user.profileImageUrl}
                  alt={userDisplayName(msg.user)}
                  className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 object-cover"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-[9px] font-bold text-primary dark:text-foreground">
                    {userInitials(msg.user)}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-semibold text-foreground">
                    {userDisplayName(msg.user)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                  </span>
                  {msg.editedAt && (
                    <span className="text-[10px] text-muted-foreground/50 italic">edited</span>
                  )}
                </div>
                <p className="text-xs text-foreground break-words whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>
                {Object.keys(msg.reactionCounts).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {Object.entries(msg.reactionCounts).map(([emoji, count]) => (
                      <span
                        key={emoji}
                        className="inline-flex items-center gap-0.5 text-[10px] bg-surface-warm-1 rounded-full px-1.5 py-0.5"
                      >
                        {emoji} <span className="text-muted-foreground">{count}</span>
                      </span>
                    ))}
                  </div>
                )}
                {msg.replyCount > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {msg.replyCount} {msg.replyCount === 1 ? "reply" : "replies"}
                  </p>
                )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-border pt-3 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message the team about ${clientName}… (Ctrl+Enter to send)`}
            className="text-xs min-h-[60px] resize-none border-primary/20 focus:ring-primary/30"
            data-testid="input-chatter-draft"
            disabled={sendMutation.isPending}
          />
          <div className="flex justify-between items-center">
            <p className="text-[10px] text-muted-foreground/60">
              Message will be posted to{" "}
              {clientChannel ? `#${clientChannel.name}` : "a new private channel for this client"}
            </p>
            <Button
              size="sm"
              className="h-7 text-xs bg-primary hover:bg-primary/90 text-primary-foreground gap-1"
              onClick={handleSend}
              disabled={!draft.trim() || sendMutation.isPending}
              data-testid="button-send-chatter"
            >
              {sendMutation.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Send className="w-3 h-3" />
              )}
              Send
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
