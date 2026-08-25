import React, { useState, useRef, useEffect, useMemo } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Phone, User, Users, ExternalLink, AlertCircle } from "lucide-react";
import { friendlySmsFailureReason } from "@/lib/smsErrors";
import { format } from "date-fns";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { groupItemsByDay } from "@/lib/conversationModel";
import { buildContactHubUrl } from "@/lib/contactHubUrl";

type Conversation = {
  id: string;
  clientId: string | null;
  contactPhone: string;
  contactName: string | null;
  twilioPhoneNumber: string;
  status: string;
  conversationType: string;
  participants: { phone: string; name?: string }[] | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number | null;
};

type Message = {
  id: string;
  conversationId: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
};

function SmsStatusBadge({
  status,
  errorCode,
  errorMessage,
  "data-testid": testId,
}: {
  status: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  "data-testid"?: string;
}) {
  const isFailed = status === "failed" || status === "undelivered";
  const label =
    status === "delivered" ? "Delivered" :
    status === "sent" ? "Sent" :
    status === "queued" || status === "accepted" || status === "scheduled" ? "Queued" :
    status === "sending" ? "Sending" :
    status === "failed" ? "Failed" :
    status === "undelivered" ? "Undelivered" :
    status;
  const badge = (
    <span
      className={`${isFailed ? "text-red-300" : ""} ${errorCode ? "underline decoration-dotted underline-offset-2 cursor-help" : ""}`}
      data-testid={testId}
    >
      {" · "}{label}
    </span>
  );
  if (errorCode) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" align="end">
          <span className="text-xs">
            Twilio error {errorCode}{errorMessage ? `: ${errorMessage}` : ""}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}

// Task #4305 — hub deep links are built by the shared helper (one comms
// flow across profile surfaces); local alias keeps call sites unchanged.
const buildHubUrl = buildContactHubUrl;

function ThreadMessages({ convId }: { convId: string }) {
  const { data: messages = [], isLoading } = useQuery<Message[]>({
    queryKey: ["/api/twilio/conversations", convId, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/conversations/${convId}/messages`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
  });

  const sorted = useMemo(() => [...messages].reverse(), [messages]);
  const byDay = useMemo(
    () => groupItemsByDay(sorted, (m) => new Date(m.createdAt), { month: "short" }),
    [sorted],
  );
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() }); }, [messages.length]);

  if (isLoading) return <InlineLoadingSkeleton lines={3} />;
  if (sorted.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-4 text-xs" data-testid="text-no-thread-messages">
        No messages in this thread
      </div>
    );
  }

  return (
    <div className="space-y-2 overflow-y-auto max-h-64 p-3">
      {byDay.map((group) => (
        <React.Fragment key={group.date}>
          <div className="flex items-center gap-2 py-0.5" data-testid={`separator-day-${group.date}`}>
            <div className="flex-1 h-px bg-muted" />
            <span className="text-caption font-medium text-muted-foreground whitespace-nowrap">{group.label}</span>
            <div className="flex-1 h-px bg-muted" />
          </div>
          {group.items.map((msg) => {
            const isFailed =
              msg.direction === "outbound" &&
              (msg.status === "failed" || msg.status === "undelivered");
            return (
              <div
                key={msg.id}
                className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                data-testid={`message-${msg.id}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                    msg.direction === "outbound"
                      ? "bg-primary text-primary-foreground rounded-br-md"
                      : "bg-muted text-foreground rounded-bl-md"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.body}</p>
                  {isFailed && (
                    <div
                      className="mt-1 flex items-center gap-1 rounded-md bg-white/15 px-2 py-0.5 text-[11px] text-white"
                      data-testid={`reason-sms-${msg.id}`}
                    >
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">
                        {friendlySmsFailureReason(msg.errorCode, msg.errorMessage)}
                      </span>
                    </div>
                  )}
                  <div className={`flex items-center gap-1 text-caption mt-0.5 ${msg.direction === "outbound" ? "text-white/60" : "text-muted-foreground"}`}>
                    <span title={format(new Date(msg.createdAt), "MMM d, yyyy h:mm a")}>
                      {format(new Date(msg.createdAt), "h:mm a")}
                    </span>
                    {msg.direction === "outbound" && (
                      <SmsStatusBadge
                        status={msg.status}
                        errorCode={msg.errorCode ?? null}
                        errorMessage={msg.errorMessage ?? null}
                        data-testid={`status-sms-${msg.id}`}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </React.Fragment>
      ))}
      <div ref={endRef} />
    </div>
  );
}

export default function ClientMessaging({
  clientId,
  sortOrder = "newest",
}: {
  clientId: string;
  sortOrder?: "newest" | "oldest";
}) {
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

  const { data: twilioConfig, isLoading: configLoading } = useQuery<{ isConfigured: boolean; phoneNumbers: string[] }>({
    queryKey: ["/api/twilio/config"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/config", { credentials: "include" });
      if (!res.ok) return { isConfigured: false, phoneNumbers: [] };
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: conversations = [], isLoading: convsLoading } = useQuery<Conversation[]>({
    queryKey: ["/api/twilio/conversations", "client", clientId],
    queryFn: async () => {
      const res = await fetch(`/api/twilio/conversations?clientId=${clientId}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!twilioConfig?.isConfigured,
    staleTime: 30_000,
  });

  const sortedConversations = useMemo(() => {
    const ts = (c: Conversation) => (c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0);
    return [...conversations].sort((a, b) =>
      sortOrder === "oldest" ? ts(a) - ts(b) : ts(b) - ts(a),
    );
  }, [conversations, sortOrder]);

  const selectedConv = conversations.find((c) => c.id === selectedConvId) ?? null;

  const getConversationDisplayName = (conv: Conversation) => {
    if (conv.conversationType === "group" && conv.participants && conv.participants.length > 1) {
      return conv.participants.map((p) => p.name || p.phone).join(", ");
    }
    return conv.contactName || conv.contactPhone;
  };

  if (configLoading) {
    return (
      <Card className="bg-card border-border" data-testid="card-messaging-loading">
        <CardContent className="py-8">
          <InlineLoadingSkeleton lines={4} />
        </CardContent>
      </Card>
    );
  }

  if (!twilioConfig?.isConfigured) {
    return (
      <Card className="bg-card border-border" data-testid="card-twilio-not-configured">
        <CardContent className="py-12 text-center text-muted-foreground">
          <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="font-medium">SMS not configured</p>
          <p className="text-sm mt-1">Ask an admin to set up Twilio in the integrations settings.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="client-messaging-container">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <MessageSquare className="w-5 h-5" />
          SMS History
        </h3>
        <Button
          size="sm"
          variant="outline"
          className="border-primary/20 text-primary-ink"
          onClick={() => window.open(buildHubUrl({ clientId, intent: "message" }), "_blank")}
          data-testid="button-open-hub-new-message"
        >
          <ExternalLink className="w-3.5 h-3.5 mr-1" />
          New Message in Hub
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:min-h-[420px]">
        <Card className="md:col-span-1 flex flex-col overflow-hidden max-h-80 md:max-h-none" data-testid="card-client-conv-list">
          <CardContent className="flex-1 overflow-y-auto p-2 space-y-1">
            {convsLoading ? (
              <div className="py-4"><InlineLoadingSkeleton lines={3} /></div>
            ) : conversations.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm" data-testid="text-no-client-conversations">
                No SMS threads with this client yet
              </div>
            ) : (
              sortedConversations.map((conv) => {
                const isGroup = conv.conversationType === "group";
                const participantCount = conv.participants?.length || 0;
                const isSelected = selectedConvId === conv.id;
                return (
                  <div key={conv.id} className="space-y-1">
                    <button
                      onClick={() => setSelectedConvId(isSelected ? null : conv.id)}
                      className={`w-full text-left p-3 rounded-lg transition-colors ${
                        isSelected
                          ? "bg-primary/10 border border-primary/20"
                          : "hover:bg-muted/50 border border-transparent"
                      }`}
                      data-testid={`button-client-conv-${conv.id}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            {isGroup ? (
                              <Users className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                            ) : (
                              <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            )}
                            <span className="font-medium text-sm truncate">
                              {getConversationDisplayName(conv)}
                            </span>
                            {isGroup && participantCount > 0 && (
                              <Badge variant="secondary" className="text-caption px-1 py-0 bg-primary/10 text-primary">
                                {participantCount}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {conv.lastMessagePreview || "No messages"}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 flex-shrink-0 ml-2">
                          {conv.lastMessageAt && (
                            <span className="text-caption text-muted-foreground">
                              {format(new Date(conv.lastMessageAt), "MMM d")}
                            </span>
                          )}
                          {(conv.unreadCount || 0) > 0 && (
                            <Badge className="bg-primary text-primary-foreground text-caption px-1.5 py-0">
                              {conv.unreadCount}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </button>
                    <div className="flex gap-1.5 px-3 pb-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-7 text-xs border-primary/20 text-primary-ink"
                        onClick={() =>
                          window.open(
                            buildHubUrl({ convId: conv.id, intent: "message" }),
                            "_blank",
                          )
                        }
                        data-testid={`button-hub-message-${conv.id}`}
                      >
                        <MessageSquare className="w-3 h-3 mr-1" />
                        Message
                      </Button>
                      {!isGroup && conv.contactPhone && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 h-7 text-xs border-primary/20 text-primary-ink"
                          onClick={() =>
                            window.open(
                              buildHubUrl({
                                convId: conv.id,
                                phone: conv.contactPhone,
                                intent: "call",
                              }),
                              "_blank",
                            )
                          }
                          data-testid={`button-hub-call-${conv.id}`}
                        >
                          <Phone className="w-3 h-3 mr-1" />
                          Call
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 flex flex-col overflow-hidden h-[70vh] max-h-[560px] md:h-auto md:max-h-none" data-testid="card-client-message-thread">
          {selectedConv ? (
            <>
              <CardHeader className="pb-2 flex-shrink-0 border-b py-2 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base text-foreground truncate" data-testid="text-thread-title">
                      {getConversationDisplayName(selectedConv)}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Read-only — use the Hub to send or call
                    </p>
                  </div>
                  <div className="flex gap-2 ml-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs border-primary/20 text-primary-ink"
                      onClick={() =>
                        window.open(
                          buildHubUrl({ convId: selectedConv.id, intent: "message" }),
                          "_blank",
                        )
                      }
                      data-testid="button-open-thread-in-hub"
                    >
                      <ExternalLink className="w-3 h-3 mr-1" />
                      Open in Hub
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 overflow-y-auto p-0">
                <ThreadMessages convId={selectedConv.id} />
              </CardContent>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p className="text-sm">Select a thread to view messages</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Messages are read-only here — open in the Conversation Hub to send
                </p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
