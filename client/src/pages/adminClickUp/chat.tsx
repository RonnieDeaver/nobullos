// ClickUp admin — chat panel + create-channel/DM dialogs.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useCallback, useEffect, useRef } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  AlertTriangle,
  ChevronLeft,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Pencil,
  Trash2,
  Users,
  Hash,
  Send,
  SmilePlus,
  MessageCircle,
} from "lucide-react";

// ─── Chat types ───────────────────────────────────────────────────────────────

export type ChatChannel = {
  id: string;
  name: string;
  description?: string;
  is_private?: boolean;
  type?: string;
  location_type?: string;
  location_id?: string;
  member_count?: number;
};

export type ChatMessage = {
  id: string;
  content: string;
  type?: "message" | "post";
  subtype_id?: string;
  user?: { id: string | number; username: string; profilePicture?: string | null };
  created_at?: string | number;
  reactions?: Array<{ emoji: string; count: number; reacted?: boolean }>;
  reply_count?: number;
};

export type ChatSubtype = {
  id: string;
  name: string;
  description?: string;
};

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export function ChatPanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedChannel, setSelectedChannel] = useState<ChatChannel | null>(null);
  const [threadParent, setThreadParent] = useState<ChatMessage | null>(null);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showCreateDM, setShowCreateDM] = useState(false);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [editContent, setEditContent] = useState("");
  const [composeContent, setComposeContent] = useState("");
  const [composeType, setComposeType] = useState<"message" | "post">("message");
  const [composeSubtypeId, setComposeSubtypeId] = useState<string>("");
  const [replyContent, setReplyContent] = useState("");
  const [reactionPicker, setReactionPicker] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const channelsQ = useQuery<{ channels: ChatChannel[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "chat/channels"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/chat/channels`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    enabled: !!workspaceId,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const channels = channelsQ.data?.channels ?? [];

  const subtypesQ = useQuery<{ subtypes: ChatSubtype[] }>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "chat/subtypes"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/chat/subtypes`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    enabled: !!workspaceId,
    staleTime: 120_000,
  });
  const subtypes = subtypesQ.data?.subtypes ?? [];

  const messagesQ = useQuery<{ data: ChatMessage[]; next_cursor?: string }>({
    queryKey: ["/api/clickup/chat/messages", workspaceId, selectedChannel?.id],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages?limit=50`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!selectedChannel,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const messages = messagesQ.data?.data ?? [];

  const repliesQ = useQuery<{ data: ChatMessage[] }>({
    queryKey: ["/api/clickup/chat/replies", workspaceId, selectedChannel?.id, threadParent?.id],
    queryFn: () =>
      fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${threadParent!.id}/replies`,
        { credentials: "include" },
      ).then((r) => r.json()),
    enabled: !!selectedChannel && !!threadParent,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const replies = repliesQ.data?.data ?? [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() });
  }, [messages.length]);

  const invalidateMessages = useCallback(() => {
    void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
      queryKey: ["/api/clickup/chat/messages", workspaceId, selectedChannel?.id],
    });
    void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
      queryKey: ["/api/clickup/chat/replies", workspaceId, selectedChannel?.id, threadParent?.id],
    });
  }, [queryClient, workspaceId, selectedChannel?.id, threadParent?.id]);

  const sendMut = useMutation({
    mutationFn: async () => {
      const body: any = { content: composeContent, type: composeType };
      if (composeType === "post" && composeSubtypeId) body.subtype_id = composeSubtypeId;
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setComposeContent("");
      setComposeType("message");
      setComposeSubtypeId("");
      invalidateMessages();
    },
    onError: (e: any) =>
      toast({ title: "Send failed", description: e.message, variant: "destructive" }),
  });

  const replyMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${threadParent!.id}/replies`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: replyContent }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setReplyContent("");
      invalidateMessages();
    },
    onError: (e: any) =>
      toast({ title: "Reply failed", description: e.message, variant: "destructive" }),
  });

  const editMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${editingMsg!.id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: editContent }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setEditingMsg(null);
      setEditContent("");
      invalidateMessages();
    },
    onError: (e: any) =>
      toast({ title: "Edit failed", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: async (messageId: string) => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${messageId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => invalidateMessages(),
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const reactMut = useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${messageId}/reactions`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setReactionPicker(null);
      invalidateMessages();
    },
    onError: (e: any) =>
      toast({ title: "React failed", description: e.message, variant: "destructive" }),
  });

  const unreactMut = useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${selectedChannel!.id}/messages/${messageId}/reactions`,
        {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => invalidateMessages(),
    onError: (e: any) =>
      toast({ title: "Remove reaction failed", description: e.message, variant: "destructive" }),
  });

  const deleteChannelMut = useMutation({
    mutationFn: async (channelId: string) => {
      const res = await fetch(
        `/api/clickup/workspaces/${workspaceId}/chat/channels/${channelId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      setSelectedChannel(null);
      void channelsQ.refetch(); // fire-and-forget: channel list refetch
      toast({ title: "Channel deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Delete channel failed", description: e.message, variant: "destructive" }),
  });

  const COMMON_EMOJIS = ["thumbsup", "heart", "tada", "eyes", "fire", "laughing", "white_check_mark", "raised_hands"];

  function fmtMsgDate(ts?: string | number): string {
    if (!ts) return "";
    const n = typeof ts === "number" ? ts : Number(ts);
    if (isNaN(n)) return "";
    const d = new Date(n > 1e12 ? n : n * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function subtypeName(id: string): string {
    return subtypes.find((s) => s.id === id)?.name ?? id;
  }

  function channelIcon(ch: ChatChannel) {
    if (ch.type === "dm") return <Users className="w-3 h-3" />;
    return <Hash className="w-3 h-3" />;
  }

  const regularChannels = channels.filter((c) => c.type !== "dm");
  const dmChannels = channels.filter((c) => c.type === "dm");

  return (
    <div data-testid="panel-chat">
      {/* Experimental notice */}
      <div className="flex items-start gap-2 p-2 mb-3 rounded-md bg-amber-50 border border-amber-200 text-xs text-amber-800">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-500" />
        <span>
          <strong>Experimental ClickUp API</strong> — ClickUp's Chat API is still marked
          experimental. Features may change without notice.
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-3 md:min-h-[480px]">
        {/* Channel list sidebar */}
        <div className="border rounded-md bg-card flex flex-col max-h-64 md:max-h-none">
          <div className="p-2 border-b flex items-center justify-between">
            <span className="text-xs font-semibold text-foreground">Channels</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                title="New channel"
                onClick={() => setShowCreateChannel(true)}
                data-testid="button-chat-new-channel"
              >
                <Plus className="w-3 h-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                title="New DM"
                onClick={() => setShowCreateDM(true)}
                data-testid="button-chat-new-dm"
              >
                <MessageCircle className="w-3 h-3" />
              </Button>
            </div>
          </div>

          {channelsQ.isLoading ? (
            <div className="flex items-center justify-center h-20">
              <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
            </div>
          ) : channels.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">No channels yet</div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {regularChannels.length > 0 && (
                <div className="pt-1">
                  {regularChannels.map((ch) => (
                    <button
                      key={ch.id}
                      className={`w-full text-left px-2 py-1 flex items-center gap-1.5 text-xs hover:bg-purple-50 rounded mx-0.5 ${
                        selectedChannel?.id === ch.id
                          ? "bg-purple-100 text-purple-700 font-medium"
                          : "text-foreground"
                      }`}
                      onClick={() => {
                        setSelectedChannel(ch);
                        setThreadParent(null);
                      }}
                      data-testid={`button-chat-channel-${ch.id}`}
                    >
                      {channelIcon(ch)}
                      <span className="truncate">{ch.name}</span>
                      {ch.is_private && <Lock className="w-2.5 h-2.5 ml-auto text-muted-foreground flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
              {dmChannels.length > 0 && (
                <div className="pt-2">
                  <div className="px-2 py-0.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                    Direct Messages
                  </div>
                  {dmChannels.map((ch) => (
                    <button
                      key={ch.id}
                      className={`w-full text-left px-2 py-1 flex items-center gap-1.5 text-xs hover:bg-purple-50 rounded mx-0.5 ${
                        selectedChannel?.id === ch.id
                          ? "bg-purple-100 text-purple-700 font-medium"
                          : "text-foreground"
                      }`}
                      onClick={() => {
                        setSelectedChannel(ch);
                        setThreadParent(null);
                      }}
                      data-testid={`button-chat-dm-${ch.id}`}
                    >
                      <Users className="w-3 h-3" />
                      <span className="truncate">{ch.name || "DM"}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Message area */}
        <div className="border rounded-md bg-card flex flex-col min-h-0">
          {!selectedChannel ? (
            <div className="flex flex-col items-center justify-center flex-1 text-muted-foreground gap-2" data-testid="prompt-select-channel">
              <Hash className="w-6 h-6" />
              <p className="text-xs">Select a channel to start chatting</p>
            </div>
          ) : threadParent ? (
            /* Thread pane */
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b flex items-center gap-2">
                <button
                  className="text-xs text-purple-600 hover:underline flex items-center gap-1"
                  onClick={() => setThreadParent(null)}
                  data-testid="button-chat-close-thread"
                >
                  <ChevronLeft className="w-3 h-3" /> Back to #{selectedChannel.name}
                </button>
                <span className="text-xs text-muted-foreground ml-1">Thread</span>
              </div>

              {/* Parent message */}
              <div className="px-3 pt-3 pb-2 border-b bg-purple-50">
                <div className="flex items-start gap-2">
                  <div className="w-5 h-5 rounded-full bg-purple-200 flex items-center justify-center text-[9px] font-bold text-purple-700 flex-shrink-0">
                    {(threadParent.user?.username ?? "?")[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 mb-0.5">
                      <span className="text-xs font-semibold text-foreground">{threadParent.user?.username ?? "Unknown"}</span>
                      <span className="text-[10px] text-muted-foreground">{fmtMsgDate(threadParent.created_at)}</span>
                      {threadParent.type === "post" && threadParent.subtype_id && (
                        <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-300 text-amber-700 bg-amber-50">
                          {subtypeName(threadParent.subtype_id)}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-foreground whitespace-pre-wrap break-words">{threadParent.content}</p>
                  </div>
                </div>
              </div>

              {/* Replies */}
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
                {repliesQ.isLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
                  </div>
                ) : replies.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No replies yet</p>
                ) : (
                  replies.map((r) => (
                    <div key={r.id} className="flex items-start gap-2 group" data-testid={`chat-reply-${r.id}`}>
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[9px] font-bold text-muted-foreground flex-shrink-0">
                        {(r.user?.username ?? "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-xs font-semibold text-foreground">{r.user?.username ?? "Unknown"}</span>
                          <span className="text-[10px] text-muted-foreground">{fmtMsgDate(r.created_at)}</span>
                        </div>
                        <p className="text-xs text-foreground whitespace-pre-wrap break-words">{r.content}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Reply composer */}
              <div className="p-2 border-t flex gap-2">
                <Textarea
                  value={replyContent}
                  onChange={(e) => setReplyContent(e.target.value)}
                  placeholder="Reply in thread…"
                  className="text-xs resize-none h-16 min-h-0"
                  data-testid="input-chat-reply"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && replyContent.trim()) {
                      e.preventDefault();
                      replyMut.mutate();
                    }
                  }}
                />
                <Button
                  size="sm"
                  className="self-end bg-purple-600 hover:bg-purple-700 text-white"
                  disabled={!replyContent.trim() || replyMut.isPending}
                  onClick={() => replyMut.mutate()}
                  data-testid="button-chat-send-reply"
                >
                  {replyMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                </Button>
              </div>
            </div>
          ) : (
            /* Main channel pane */
            <div className="flex flex-col flex-1 min-h-0">
              {/* Channel header */}
              <div className="px-3 py-2 border-b flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {channelIcon(selectedChannel)}
                  <span className="text-sm font-semibold text-foreground">{selectedChannel.name}</span>
                  {selectedChannel.is_private && <Lock className="w-3 h-3 text-muted-foreground" />}
                  {selectedChannel.description && (
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">{selectedChannel.description}</span>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={() => messagesQ.refetch()}
                    data-testid="button-chat-refresh"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </Button>
                  <ConfirmActionDialog
                    trigger={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs text-red-500 hover:text-red-700"
                        data-testid="button-chat-delete-channel"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    }
                    title={`Delete channel "${selectedChannel.name}"?`}
                    description="This deletes the channel and its messages in ClickUp for every member. This cannot be undone."
                    confirmLabel="Delete channel"
                    onConfirm={() => deleteChannelMut.mutate(selectedChannel.id)}
                    testId="dialog-chat-delete-channel"
                  />
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
                {messagesQ.isLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
                  </div>
                ) : messagesQ.isError ? (
                  <div className="text-xs text-red-500 text-center py-4">
                    Failed to load messages
                  </div>
                ) : messages.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-8">No messages yet — be the first!</p>
                ) : (
                  messages.map((msg) => (
                    <div key={msg.id} className="flex items-start gap-2 group" data-testid={`chat-message-${msg.id}`}>
                      <div className="w-6 h-6 rounded-full bg-purple-200 flex items-center justify-center text-[10px] font-bold text-purple-700 flex-shrink-0">
                        {(msg.user?.username ?? "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 mb-0.5">
                          <span className="text-xs font-semibold text-foreground">{msg.user?.username ?? "Unknown"}</span>
                          <span className="text-[10px] text-muted-foreground">{fmtMsgDate(msg.created_at)}</span>
                          {msg.type === "post" && msg.subtype_id && (
                            <Badge variant="outline" className="text-[9px] py-0 h-4 border-amber-300 text-amber-700 bg-amber-50">
                              {subtypeName(msg.subtype_id)}
                            </Badge>
                          )}
                        </div>

                        {editingMsg?.id === msg.id ? (
                          <div className="flex gap-1 mt-1">
                            <Textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              className="text-xs resize-none h-14 min-h-0 flex-1"
                              data-testid="input-chat-edit"
                            />
                            <div className="flex flex-col gap-1">
                              <Button
                                size="sm"
                                className="h-6 text-xs bg-purple-600 hover:bg-purple-700 text-white"
                                disabled={!editContent.trim() || editMut.isPending}
                                onClick={() => editMut.mutate()}
                                data-testid="button-chat-save-edit"
                              >
                                {editMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-xs"
                                onClick={() => { setEditingMsg(null); setEditContent(""); }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-xs text-foreground whitespace-pre-wrap break-words">{msg.content}</p>
                        )}

                        {/* Reactions + actions */}
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {(msg.reactions ?? []).map((r) => (
                            <button
                              key={r.emoji}
                              className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                                r.reacted
                                  ? "bg-purple-100 border-purple-300 text-purple-700"
                                  : "bg-muted/50 border-border text-muted-foreground hover:bg-muted"
                              }`}
                              onClick={() =>
                                r.reacted
                                  ? unreactMut.mutate({ messageId: msg.id, emoji: r.emoji })
                                  : reactMut.mutate({ messageId: msg.id, emoji: r.emoji })
                              }
                              data-testid={`button-reaction-${msg.id}-${r.emoji}`}
                            >
                              <span>:{r.emoji}:</span>
                              {r.count > 1 && <span>{r.count}</span>}
                            </button>
                          ))}

                          {/* Action bar — visible on hover */}
                          <div className="ml-auto hidden group-hover:flex items-center gap-1">
                            <button
                              className="text-[10px] text-muted-foreground hover:text-purple-600 p-0.5"
                              title="Add reaction"
                              onClick={() => setReactionPicker(reactionPicker === msg.id ? null : msg.id)}
                              data-testid={`button-emoji-picker-${msg.id}`}
                            >
                              <SmilePlus className="w-3 h-3" />
                            </button>
                            <button
                              className="text-[10px] text-muted-foreground hover:text-blue-600 p-0.5"
                              title="Reply in thread"
                              onClick={() => setThreadParent(msg)}
                              data-testid={`button-thread-${msg.id}`}
                            >
                              <MessageCircle className="w-3 h-3" />
                              {(msg.reply_count ?? 0) > 0 && (
                                <span className="ml-0.5 text-blue-500">{msg.reply_count}</span>
                              )}
                            </button>
                            <button
                              className="text-[10px] text-muted-foreground hover:text-muted-foreground p-0.5"
                              title="Edit"
                              onClick={() => { setEditingMsg(msg); setEditContent(msg.content); }}
                              data-testid={`button-edit-msg-${msg.id}`}
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <ConfirmActionDialog
                              trigger={
                                <button
                                  className="text-[10px] text-muted-foreground hover:text-red-600 p-0.5"
                                  title="Delete"
                                  data-testid={`button-delete-msg-${msg.id}`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              }
                              title="Delete this message?"
                              description="This deletes the message from the ClickUp channel for everyone. Thread replies and reactions on it are removed too. This cannot be undone."
                              confirmLabel="Delete"
                              onConfirm={() => deleteMut.mutate(msg.id)}
                              testId={`dialog-delete-msg-${msg.id}`}
                            />
                          </div>
                        </div>

                        {/* Emoji picker popover */}
                        {reactionPicker === msg.id && (
                          <div
                            className="flex flex-wrap gap-1 mt-1 p-2 bg-card border rounded shadow-sm"
                            data-testid={`emoji-picker-${msg.id}`}
                          >
                            {COMMON_EMOJIS.map((e) => (
                              <button
                                key={e}
                                className="text-xs px-1.5 py-0.5 rounded hover:bg-purple-50 border border-transparent hover:border-purple-200"
                                onClick={() => reactMut.mutate({ messageId: msg.id, emoji: e })}
                                data-testid={`emoji-${e}`}
                              >
                                :{e}:
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer */}
              <div className="p-2 border-t space-y-1.5">
                {composeType === "post" && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Post type:</span>
                    <Select
                      value={composeSubtypeId}
                      onValueChange={setComposeSubtypeId}
                    >
                      <SelectTrigger className="h-6 text-xs w-40" data-testid="select-post-subtype">
                        <SelectValue placeholder="Select subtype…" />
                      </SelectTrigger>
                      <SelectContent>
                        {subtypes.map((s) => (
                          <SelectItem key={s.id} value={s.id} className="text-xs">
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex gap-1.5 items-end">
                  <div className="flex-1 space-y-1">
                    <div className="flex gap-1 mb-1">
                      <button
                        className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                          composeType === "message"
                            ? "bg-purple-100 border-purple-300 text-purple-700"
                            : "border-border text-muted-foreground hover:bg-muted/50"
                        }`}
                        onClick={() => setComposeType("message")}
                        data-testid="button-compose-message"
                      >
                        Message
                      </button>
                      <button
                        className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                          composeType === "post"
                            ? "bg-amber-100 border-amber-300 text-amber-700"
                            : "border-border text-muted-foreground hover:bg-muted/50"
                        }`}
                        onClick={() => setComposeType("post")}
                        data-testid="button-compose-post"
                      >
                        Post
                      </button>
                    </div>
                    <Textarea
                      value={composeContent}
                      onChange={(e) => setComposeContent(e.target.value)}
                      placeholder={`Message #${selectedChannel.name}…`}
                      className="text-xs resize-none h-16 min-h-0"
                      data-testid="input-chat-compose"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && composeContent.trim()) {
                          e.preventDefault();
                          sendMut.mutate();
                        }
                      }}
                    />
                  </div>
                  <Button
                    size="sm"
                    className="self-end bg-purple-600 hover:bg-purple-700 text-white"
                    disabled={!composeContent.trim() || sendMut.isPending}
                    onClick={() => sendMut.mutate()}
                    data-testid="button-chat-send"
                  >
                    {sendMut.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Send className="w-3 h-3" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Channel Dialog */}
      <CreateChatChannelDialog
        open={showCreateChannel}
        workspaceId={workspaceId}
        onClose={() => setShowCreateChannel(false)}
        onCreated={(ch) => {
          void channelsQ.refetch(); // fire-and-forget: channel list refetch
          setSelectedChannel(ch);
          setShowCreateChannel(false);
        }}
      />

      {/* Create DM Dialog */}
      <CreateDMDialog
        open={showCreateDM}
        workspaceId={workspaceId}
        onClose={() => setShowCreateDM(false)}
        onCreated={(ch) => {
          void channelsQ.refetch(); // fire-and-forget: channel list refetch
          setSelectedChannel(ch);
          setShowCreateDM(false);
        }}
      />
    </div>
  );
}

export function CreateChatChannelDialog({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  onClose(): void;
  onCreated(ch: ChatChannel): void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/workspaces/${workspaceId}/chat/channels`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || undefined, is_private: isPrivate }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ channel: ChatChannel }>;
    },
    onSuccess: (data) => {
      setName("");
      setDescription("");
      setIsPrivate(false);
      onCreated(data.channel);
      toast({ title: `Channel "${data.channel.name}" created` });
    },
    onError: (e: any) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">New Channel</DialogTitle>
          <DialogDescription className="text-xs">
            Create a workspace-level chat channel. ClickUp returns the existing channel if a channel with this name already exists.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-xs mb-1 block">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. general"
              className="text-xs h-7"
              data-testid="input-channel-name"
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this channel about?"
              className="text-xs h-7"
              data-testid="input-channel-description"
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={isPrivate}
              onCheckedChange={setIsPrivate}
              id="channel-private"
              data-testid="switch-channel-private"
            />
            <Label htmlFor="channel-private" className="text-xs">Private channel</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button
            size="sm"
            className="bg-purple-600 hover:bg-purple-700 text-white text-xs"
            disabled={!name.trim() || createMut.isPending}
            onClick={() => createMut.mutate()}
            data-testid="button-create-channel-confirm"
          >
            {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreateDMDialog({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  onClose(): void;
  onCreated(ch: ChatChannel): void;
}) {
  const { toast } = useToast();
  const [userIdsInput, setUserIdsInput] = useState("");

  const createMut = useMutation({
    mutationFn: async () => {
      const ids = userIdsInput
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) throw new Error("Enter at least one user ID");
      if (ids.length > 15) throw new Error("DMs support at most 15 users");
      const res = await fetch(`/api/clickup/workspaces/${workspaceId}/chat/channels/dm`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_ids: ids }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ channel: ChatChannel }>;
    },
    onSuccess: (data) => {
      setUserIdsInput("");
      onCreated(data.channel);
      toast({ title: "DM channel opened" });
    },
    onError: (e: any) =>
      toast({ title: "Create DM failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">New Direct Message</DialogTitle>
          <DialogDescription className="text-xs">
            Enter ClickUp user IDs (comma or space separated, up to 15). ClickUp returns the existing DM if one already exists with these members.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Label className="text-xs mb-1 block">User IDs</Label>
          <Textarea
            value={userIdsInput}
            onChange={(e) => setUserIdsInput(e.target.value)}
            placeholder="12345678 87654321"
            className="text-xs resize-none h-16"
            data-testid="input-dm-user-ids"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
          <Button
            size="sm"
            className="bg-purple-600 hover:bg-purple-700 text-white text-xs"
            disabled={!userIdsInput.trim() || createMut.isPending}
            onClick={() => createMut.mutate()}
            data-testid="button-create-dm-confirm"
          >
            {createMut.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Open DM
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

