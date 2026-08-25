import { useState, useRef, useEffect } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Bot, User, Send, Trash2, Loader2 } from "lucide-react";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { ChatLoadingSkeleton } from "@/components/ui/skeleton-loaders";

type ChatMessage = {
  id: string;
  clientId: string;
  role: string;
  content: string;
  createdAt: string;
};

export default function ClientAgentChat({ clientId }: { clientId: string }) {
  const [input, setInput] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: messages = [], isLoading } = useQuery<ChatMessage[]>({
    queryKey: [`/api/clients/${clientId}/agent-chat`],
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior() });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent]);

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/agent-chat`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear chat");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-chat`] }); // fire-and-forget: cache refresh only
      setStreamingContent("");
      toast({ title: "Chat cleared" });
    },
  });

  const sendMessage = async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    setInput("");
    setIsStreaming(true);
    setStreamingContent("");
    setPendingUserMessage(trimmed);

    try {
      const res = await fetch(`/api/clients/${clientId}/agent-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });

      if (!res.ok) {
        throw new Error("Failed to send message");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.content) {
                  accumulated += data.content;
                  setStreamingContent(accumulated);
                }
                if (data.done) {
                  break;
                }
                if (data.error) {
                  toast({ title: "Error", description: data.error, variant: "destructive" });
                }
              } catch {}
            }
          }
        }
      }

      await queryClient.invalidateQueries({ queryKey: [`/api/clients/${clientId}/agent-chat`] });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setIsStreaming(false);
      setStreamingContent("");
      setPendingUserMessage(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(); // fire-and-forget: errors handled inside sendMessage
    }
  };

  return (
    <Card className="bg-card border-border" data-testid="card-agent-chat">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-foreground flex items-center gap-2 text-base">
          <Bot className="w-5 h-5" />
          Agent Chat
        </CardTitle>
        <ConfirmActionDialog
          title="Clear all chat history for this client?"
          description="Every agent chat message for this client is deleted for all team members. This cannot be undone."
          confirmLabel="Clear chat"
          testId="dialog-confirm-clear-chat"
          onConfirm={() => clearMutation.mutate()}
          trigger={
            <Button
              size="sm"
              variant="outline"
              className="text-red-500 hover:text-red-700 border-red-200 hover:border-red-300"
              disabled={clearMutation.isPending || messages.length === 0}
              data-testid="button-clear-chat"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Clear Chat
            </Button>
          }
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          className="h-[400px] overflow-y-auto border border-border rounded-lg p-3 space-y-3 bg-[#FAFAF8]"
          data-testid="chat-message-list"
        >
          {isLoading && (
            <ChatLoadingSkeleton />
          )}
          {!isLoading && messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm" data-testid="text-empty-chat">
              <Bot className="w-8 h-8 mb-2 opacity-50" />
              <p>Ask anything about this client.</p>
              <p className="text-xs mt-1">The agent has context from their profile, strategy, communications, and more.</p>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              data-testid={`chat-message-${msg.id}`}
            >
              {msg.role === "assistant" && (
                <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-1">
                  <Bot className="w-4 h-4 text-white" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border text-foreground"
                }`}
              >
                {msg.content}
              </div>
              {msg.role === "user" && (
                <div className="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0 mt-1">
                  <User className="w-4 h-4 text-muted-foreground" />
                </div>
              )}
            </div>
          ))}
          {pendingUserMessage && (
            <div className="flex gap-2 justify-end" data-testid="chat-message-pending">
              <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-primary text-primary-foreground">
                {pendingUserMessage}
              </div>
              <div className="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center flex-shrink-0 mt-1">
                <User className="w-4 h-4 text-muted-foreground" />
              </div>
            </div>
          )}
          {isStreaming && streamingContent && (
            <div className="flex gap-2 justify-start" data-testid="chat-message-streaming">
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-1">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-card border border-border text-foreground">
                {streamingContent}
                <span className="inline-block w-1.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
              </div>
            </div>
          )}
          {isStreaming && !streamingContent && (
            <div className="flex gap-2 justify-start" data-testid="chat-message-thinking">
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center flex-shrink-0 mt-1">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-card border border-border text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Thinking...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this client..."
            className="resize-none min-h-[44px] max-h-[120px]"
            rows={1}
            disabled={isStreaming}
            data-testid="input-agent-chat"
          />
          <Button
            onClick={sendMessage}
            disabled={!input.trim() || isStreaming}
            className="bg-primary hover:bg-primary/90 h-auto px-3"
            data-testid="button-send-chat"
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
