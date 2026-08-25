import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Loader2,
  MessageSquare,
  Mail,
  Video,
  FileText,
  AlertCircle,
  CheckCircle,
  AlertTriangle,
  Lightbulb,
  Clock,
  TrendingUp,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Phone,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface ConversationSummaryPanelProps {
  clientId: string;
}

type SummaryData = {
  id: string;
  clientId: string;
  summaryJson: {
    empty?: boolean;
    communicationPulse?: {
      total14Days: number;
      total30Days: number;
      byChannel: Record<string, number>;
      lastContactDate: string | null;
      inboundCount: number;
      outboundCount: number;
      touchpointCount30Days?: number;
      lastTouchpointDate?: string | null;
    };
    keyTakeaways?: Array<{
      text: string;
      category: "request" | "decision" | "concern" | "win";
      recency: "recent" | "older";
    }>;
    openThreads?: Array<{
      text: string;
      urgency: "high" | "medium" | "low";
    }>;
    toneAndEngagement?: string;
  };
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  commCount: number;
};

const channelIcons: Record<string, any> = {
  slack: MessageSquare,
  front_email: Mail,
  zoom: Video,
  manual: FileText,
};

const channelLabels: Record<string, string> = {
  slack: "Slack",
  front_email: "Email",
  zoom: "Zoom",
  manual: "Manual",
};

const categoryIcons: Record<string, any> = {
  request: AlertCircle,
  decision: CheckCircle,
  concern: AlertTriangle,
  win: Lightbulb,
};

const categoryColors: Record<string, string> = {
  request: "text-blue-600",
  decision: "text-green-600",
  concern: "text-amber-600",
  win: "text-emerald-600",
};

const urgencyColors: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-muted text-muted-foreground border-border",
};

export default function ConversationSummaryPanel({ clientId }: ConversationSummaryPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isExpanded, setIsExpanded] = useState(true);

  const { data: summary, isLoading, isError } = useQuery<SummaryData | null>({
    queryKey: ["/api/clients", clientId, "conversation-summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/clients/${clientId}/conversation-summary`);
      const data = await res.json();
      return data;
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/clients/${clientId}/conversation-summary/regenerate`);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "conversation-summary"] }); // fire-and-forget: cache refresh only
      toast({ title: "Summary regenerated" });
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to regenerate summary", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <Card className="mb-4 bg-gradient-to-r from-surface-warm-1 to-white border-border" data-testid="conversation-summary-loading">
        <CardContent className="py-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading conversation summary...</span>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className="mb-4 bg-gradient-to-r from-surface-warm-1 to-white border-border" data-testid="conversation-summary-error">
        <CardContent className="py-6 flex items-center justify-center gap-2 text-muted-foreground">
          <AlertCircle className="w-4 h-4 text-red-400" />
          <span className="text-sm">Unable to load conversation summary.</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "conversation-summary"] })}
            data-testid="button-retry-summary"
          >
            <RefreshCw className="w-3 h-3 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isEmpty = !summary || summary.summaryJson?.empty;
  const hasNeverGenerated = !summary;
  const s = summary?.summaryJson;

  return (
    <Card className="mb-4 bg-gradient-to-r from-surface-warm-1 to-white border-border" data-testid="conversation-summary-panel">
      <CardHeader className="pb-2 cursor-pointer" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <CardTitle className="text-foreground text-base" data-testid="text-summary-title">
              Conversation Summary
            </CardTitle>
            {summary && !isEmpty && (
              <span className="text-xs text-muted-foreground" data-testid="text-summary-timestamp">
                Updated {formatDistanceToNow(new Date(summary.generatedAt), { addSuffix: true })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-primary-ink/60 hover:text-primary-ink"
              onClick={(e) => {
                e.stopPropagation();
                regenerateMutation.mutate();
              }}
              disabled={regenerateMutation.isPending}
              data-testid="button-refresh-summary"
            >
              {regenerateMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span className="ml-1">{hasNeverGenerated ? "Generate" : "Refresh"}</span>
            </Button>
            {isExpanded ? (
              <ChevronUp className="w-4 h-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-4 h-4 text-muted-foreground" />
            )}
          </div>
        </div>
      </CardHeader>

      {isExpanded && (
        <CardContent className="pt-0">
          {hasNeverGenerated ? (
            <div className="text-center py-6" data-testid="summary-empty-state">
              <p className="text-sm text-muted-foreground mb-2">
                No summary generated yet. Click "Generate" to create one.
              </p>
            </div>
          ) : isEmpty ? (
            <div className="text-center py-6" data-testid="summary-no-comms">
              <p className="text-sm text-muted-foreground">
                No recent communications in the last 30 days.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {s?.communicationPulse && (
                <div data-testid="summary-section-pulse">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Communication Pulse
                  </h4>
                  <div className="flex flex-wrap gap-3">
                    <div className="flex items-center gap-1.5 bg-card rounded-md px-2.5 py-1.5 border border-border text-sm">
                      <span className="font-semibold text-foreground" data-testid="text-pulse-14d">{s.communicationPulse.total14Days}</span>
                      <span className="text-muted-foreground text-xs">in 14d</span>
                      <Minus className="w-2.5 h-2.5 text-muted-foreground mx-0.5" />
                      <span className="font-semibold text-foreground" data-testid="text-pulse-30d">{s.communicationPulse.total30Days}</span>
                      <span className="text-muted-foreground text-xs">in 30d</span>
                    </div>

                    {Object.entries(s.communicationPulse.byChannel).map(([channel, count]) => {
                      const Icon = channelIcons[channel] || FileText;
                      const label = channelLabels[channel] || channel;
                      return (
                        <div key={channel} className="flex items-center gap-1.5 bg-card rounded-md px-2.5 py-1.5 border border-border text-sm" data-testid={`text-channel-${channel}`}>
                          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground text-xs">{label}</span>
                          <span className="font-medium">{count}</span>
                        </div>
                      );
                    })}

                    <div className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 border text-sm ${(s.communicationPulse.touchpointCount30Days ?? 0) > 0 ? "bg-emerald-50 border-emerald-200" : "bg-red-50 border-red-200"}`} data-testid="text-touchpoint-count">
                      <Phone className="w-3.5 h-3.5 text-emerald-600" />
                      <span className={`font-semibold ${(s.communicationPulse.touchpointCount30Days ?? 0) > 0 ? "text-emerald-700" : "text-red-600"}`}>
                        {s.communicationPulse.touchpointCount30Days ?? 0}
                      </span>
                      <span className="text-muted-foreground text-xs">touchpoints in 30d</span>
                    </div>

                    {s.communicationPulse.lastTouchpointDate && (
                      <div className="flex items-center gap-1.5 bg-emerald-50 rounded-md px-2.5 py-1.5 border border-emerald-200 text-sm" data-testid="text-last-touchpoint">
                        <Clock className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-muted-foreground text-xs">Last touchpoint</span>
                        <span className="font-medium text-emerald-700">
                          {format(new Date(s.communicationPulse.lastTouchpointDate), "MMM d")}
                        </span>
                      </div>
                    )}

                    {s.communicationPulse.lastContactDate && (
                      <div className="flex items-center gap-1.5 bg-card rounded-md px-2.5 py-1.5 border border-border text-sm" data-testid="text-last-contact">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground text-xs">Last contact</span>
                        <span className="font-medium">
                          {format(new Date(s.communicationPulse.lastContactDate), "MMM d")}
                        </span>
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 bg-card rounded-md px-2.5 py-1.5 border border-border text-sm" data-testid="text-direction-ratio">
                      <ArrowDownRight className="w-3.5 h-3.5 text-blue-500" />
                      <span className="font-medium">{s.communicationPulse.inboundCount}</span>
                      <span className="text-muted-foreground text-xs">in</span>
                      <ArrowUpRight className="w-3.5 h-3.5 text-green-500" />
                      <span className="font-medium">{s.communicationPulse.outboundCount}</span>
                      <span className="text-muted-foreground text-xs">out</span>
                    </div>
                  </div>
                </div>
              )}

              {s?.keyTakeaways && s.keyTakeaways.length > 0 && (
                <div data-testid="summary-section-takeaways">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Key Takeaways
                  </h4>
                  <ul className="space-y-1.5">
                    {s.keyTakeaways.map((item, i) => {
                      const Icon = categoryIcons[item.category] || AlertCircle;
                      const colorClass = categoryColors[item.category] || "text-muted-foreground";
                      return (
                        <li key={i} className="flex items-start gap-2 text-sm" data-testid={`text-takeaway-${i}`}>
                          <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${colorClass}`} />
                          <span className={item.recency === "older" ? "text-muted-foreground" : ""}>
                            {item.text}
                          </span>
                          {item.recency === "older" && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 flex-shrink-0 border-border text-muted-foreground">
                              older
                            </Badge>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {s?.openThreads && s.openThreads.length > 0 && (
                <div data-testid="summary-section-threads">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Open Threads
                  </h4>
                  <ul className="space-y-1.5">
                    {s.openThreads.map((thread, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm" data-testid={`text-thread-${i}`}>
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 flex-shrink-0 mt-0.5 ${urgencyColors[thread.urgency]}`}
                        >
                          {thread.urgency}
                        </Badge>
                        <span>{thread.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {s?.toneAndEngagement && (
                <div data-testid="summary-section-tone">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Tone & Engagement
                  </h4>
                  <p className="text-sm text-muted-foreground italic" data-testid="text-tone">
                    {s.toneAndEngagement}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
