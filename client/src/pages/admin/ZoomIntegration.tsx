import { useState, useCallback, useRef } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Video, Loader2, X, RefreshCw, AlertCircle,
  CheckCircle, User, ExternalLink,
  ChevronDown, ChevronRight, Filter, Calendar,
  ArrowUpDown, UserPlus, Clock, Users, FileText, Search,
  Inbox, TrendingUp, TrendingDown, Wand2,
} from "lucide-react";
import { format } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useDisplayTimezone } from "@/lib/displayTimezone";
import { matchMethodLabel, matchMethodColor, matchMethodDetail, friendlyDismissReason, reviewReasonLabel } from "@/lib/matchMethod";
import { DismissReasonDialog } from "@/components/DismissReasonDialog";
import { ZoomResolvedPanel, type ZoomResolvedInfo } from "./ZoomResolvedPanel";
import { type DismissReason } from "@shared/schema";
import { parseIntegrationStatusUnknownError } from "@shared/integrationStatusUnknown";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { BreakerDetailRow } from "@/components/admin/BreakerDetailRow";
import { PageHeader } from "@/components/admin/PageHeader";

function displayMatchDetail(matchMethod: string | null | undefined): string | null {
  const raw = matchMethodDetail(matchMethod);
  if (raw && typeof matchMethod === "string" && matchMethod.toLowerCase().startsWith("dismissed:")) {
    return friendlyDismissReason(raw);
  }
  return raw;
}

type ZoomStatus = {
  connected: boolean;
};

// Task #2216 — Zoom auth-gate breaker detail forwarded by
// /api/integrations/all-status. The Zoom gate is sticky (no cooldown
// expiry, no trip counter), so only breakerOpen + lastTrippedAt apply.
// Task #2254 — cooldownUntil now carries the next self-heal attempt time and
// selfHealParked indicates the loop has stopped pending an operator reconnect.
type ZoomBreakerStatus = {
  breakerOpen?: boolean;
  lastTrippedAt?: string | null;
  cooldownUntil?: string | null;
  selfHealParked?: boolean;
  tripCount?: number;
};

type ZoomReviewCandidate = {
  clientId: string | null;
  clientName: string | null;
  confidenceScore: number | null;
  evidenceType: string | null;
  explanationSummary: string | null;
};

type ZoomReviewInfo = {
  decisionId: string;
  reviewReason: string | null;
  explanationSummary: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  suggestedConfidence: number | null;
  priorClientId: string | null;
  priorClientName: string | null;
  candidates: ZoomReviewCandidate[];
};

export type ZoomMessageFeed = {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string | null;
  contentText: string | null;
  contentPreview: string | null;
  timestamp: string;
  direction: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  externalUrl: string | null;
  googleDriveFileUrl: string | null;
  sourceSubtype: string | null;
  aiSummary: string | null;
  createdAt: string;
  rawPayload: {
    hostEmail?: string;
    hostName?: string;
    duration?: number;
    recordingCount?: number;
    hasTranscript?: boolean;
  } | null;
  participants: Array<{ name?: string; email?: string; role?: string }> | null;
  review: ZoomReviewInfo | null;
  resolved: ZoomResolvedInfo | null;
};

type MessageFeedResponse = {
  messages: ZoomMessageFeed[];
  stats: {
    total: number;
    matched: number;
    unmatched: number;
    needsReview: number;
    matchRate: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

type ClientOption = {
  id: string;
  firmName: string;
};

function formatDuration(minutes: number | undefined): string {
  if (!minutes) return "—";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

type ClientLink = {
  id: string;
  clientId: string;
  clientName: string;
  matchMethod: string;
  matchConfidence: number | null;
  isPrimary: boolean;
  status: string;
  relevantSegments: Array<{ timestamp?: string; text?: string; context?: string }> | null;
};

function MeetingClientLinks({ commId }: { commId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: links = [] } = useQuery<ClientLink[]>({
    queryKey: ["/api/communications", commId, "client-links"],
    queryFn: async () => {
      const res = await fetch(`/api/communications/${commId}/client-links`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const updateLinkMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ linkId, status }: { linkId: string; status: string }) => {
      const res = await apiRequest("PATCH", `/api/communications/client-links/${linkId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/communications", commId, "client-links"] }); // fire-and-forget: cache refresh only
      toast({ title: "Link updated" });
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  if (links.length === 0) return null;

  return (
    <div data-testid={`client-links-${commId}`}>
      <p className="text-muted-foreground font-medium mb-1 text-sm">Detected Clients ({links.length})</p>
      <div className="space-y-1.5">
        {links.map(link => (
          <div key={link.id} className="flex items-center gap-2 text-xs bg-card border rounded px-3 py-2" data-testid={`client-link-${link.id}`}>
            <Badge variant="outline" className={`text-[10px] h-4 px-1 ${link.isPrimary ? "bg-indigo-100 text-indigo-700 border-indigo-300" : "bg-muted text-muted-foreground"}`}>
              {link.isPrimary ? "Primary" : "Also mentioned"}
            </Badge>
            <span className="font-medium text-foreground">{link.clientName}</span>
            {link.matchConfidence != null && (
              <span className="text-muted-foreground">{Math.round(link.matchConfidence * 100)}%</span>
            )}
            <Badge variant="outline" className={`text-[10px] h-4 px-1 ${matchMethodColor(link.matchMethod)}`} data-testid={`badge-zoom-link-method-${link.id}`}>
              {matchMethodLabel(link.matchMethod)}
            </Badge>
            {displayMatchDetail(link.matchMethod) && (
              <span className="text-muted-foreground text-[10px] truncate max-w-[160px]" title={displayMatchDetail(link.matchMethod) ?? undefined}>
                {displayMatchDetail(link.matchMethod)}
              </span>
            )}
            {link.relevantSegments && link.relevantSegments.length > 0 && (
              <span className="text-muted-foreground text-[10px]">
                {link.relevantSegments.length} mention{link.relevantSegments.length !== 1 ? "s" : ""}
              </span>
            )}
            <div className="flex-1" />
            {link.status === "detected" && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-green-600 hover:text-green-700 hover:bg-green-50"
                  onClick={(e) => { e.stopPropagation(); updateLinkMutation.mutate({ linkId: link.id, status: "confirmed" }); }}
                  disabled={updateLinkMutation.isPending}
                  data-testid={`button-confirm-link-${link.id}`}
                >
                  <CheckCircle className="w-3 h-3 mr-0.5" /> Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-red-500 hover:text-red-600 hover:bg-red-50"
                  onClick={(e) => { e.stopPropagation(); updateLinkMutation.mutate({ linkId: link.id, status: "rejected" }); }}
                  disabled={updateLinkMutation.isPending}
                  data-testid={`button-reject-link-${link.id}`}
                >
                  <X className="w-3 h-3 mr-0.5" /> Reject
                </Button>
              </div>
            )}
            {link.status === "confirmed" && (
              <Badge variant="outline" className="text-[10px] h-4 px-1 bg-green-50 text-green-600 border-green-200">Confirmed</Badge>
            )}
            {link.status === "rejected" && (
              <Badge variant="outline" className="text-[10px] h-4 px-1 bg-red-50 text-red-500 border-red-200">Rejected</Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MeetingRow({
  msg,
  isExpanded,
  onToggle,
  clients,
  onReassign,
  isReassigning,
  userTimezone,
  onReviewApprove,
  onReviewDismiss,
  isReviewing,
}: {
  msg: ZoomMessageFeed;
  isExpanded: boolean;
  onToggle: () => void;
  clients: ClientOption[];
  onReassign: (messageId: string, clientId: string | null) => void;
  isReassigning: boolean;
  userTimezone: string;
  onReviewApprove: (decisionId: string, clientId?: string) => void;
  onReviewDismiss: (decisionId: string) => void;
  isReviewing: boolean;
}) {
  const [showClientPicker, setShowClientPicker] = useState(false);
  const hostName = msg.rawPayload?.hostName || "Unknown Host";
  const duration = msg.rawPayload?.duration;
  const participantCount = msg.participants?.length || 0;
  const hasTranscript = msg.rawPayload?.hasTranscript || false;

  return (
    <div className="border rounded-lg overflow-hidden" data-testid={`row-meeting-${msg.id}`}>
      <div
        className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onToggle}
        data-testid={`button-expand-${msg.id}`}
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate" data-testid={`text-topic-${msg.id}`}>
            {msg.title || "(Untitled Meeting)"}
          </p>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span>{hostName}</span>
            <span>·</span>
            <span>{format(toZonedTime(new Date(msg.timestamp), userTimezone), "MMM d, h:mm a")}</span>
            {duration != null && (
              <>
                <span>·</span>
                <span className="flex items-center gap-0.5">
                  <Clock className="w-3 h-3" />
                  {formatDuration(duration)}
                </span>
              </>
            )}
            {participantCount > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-0.5">
                  <Users className="w-3 h-3" />
                  {participantCount}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {hasTranscript ? (
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 text-[10px]" data-testid={`badge-transcript-${msg.id}`}>
              <FileText className="w-3 h-3 mr-0.5" />
              Transcript
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border text-[10px]" data-testid={`badge-no-transcript-${msg.id}`}>
              No Transcript
            </Badge>
          )}

          {msg.review ? (
            <Badge
              variant="outline"
              className="bg-yellow-50 text-yellow-800 border-yellow-300"
              title={reviewReasonLabel(msg.review.reviewReason)}
              data-testid={`badge-needs-review-${msg.id}`}
            >
              <AlertCircle className="w-3 h-3 mr-1" />
              Needs review
              <span className="ml-1 text-yellow-700 text-[10px]">
                · {reviewReasonLabel(msg.review.reviewReason)}
              </span>
            </Badge>
          ) : msg.clientId ? (
            <>
              <Badge variant="outline" className={matchMethodColor(msg.matchMethod)} data-testid={`badge-method-${msg.id}`}>
                {matchMethodLabel(msg.matchMethod)}
              </Badge>
              <Badge
                variant="outline"
                className="bg-green-50 text-green-700 border-green-200"
                data-testid={`badge-match-${msg.id}`}
              >
                <User className="w-3 h-3 mr-1" />
                {msg.clientName}
                {msg.matchConfidence != null && (
                  <span className="ml-1 text-green-500 text-[10px]">
                    {Math.round(msg.matchConfidence * 100)}%
                  </span>
                )}
              </Badge>
            </>
          ) : msg.matchMethod ? (
            <Badge variant="outline" className={matchMethodColor(msg.matchMethod)} data-testid={`badge-method-${msg.id}`}>
              {matchMethodLabel(msg.matchMethod)}
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border" data-testid={`badge-unmatched-${msg.id}`}>
              Unmatched
            </Badge>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t bg-muted/25 p-4 space-y-3" data-testid={`expanded-${msg.id}`}>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground font-medium mb-1">Host</p>
              <p>{hostName}</p>
              {msg.rawPayload?.hostEmail && (
                <p className="text-xs text-muted-foreground">{msg.rawPayload.hostEmail}</p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Date & Time</p>
              <p>{format(toZonedTime(new Date(msg.timestamp), userTimezone), "MMM d, yyyy h:mm:ss a")}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Duration</p>
              <p>{formatDuration(duration)}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Match Method</p>
              {msg.matchMethod ? (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={matchMethodColor(msg.matchMethod)} data-testid={`badge-match-method-detail-${msg.id}`}>
                    {matchMethodLabel(msg.matchMethod)}
                    {msg.matchConfidence != null && ` (${Math.round(msg.matchConfidence * 100)}%)`}
                  </Badge>
                  {displayMatchDetail(msg.matchMethod) && (
                    <span className="text-xs text-muted-foreground truncate max-w-[260px]" title={displayMatchDetail(msg.matchMethod) ?? undefined} data-testid={`text-match-method-detail-${msg.id}`}>
                      {displayMatchDetail(msg.matchMethod)}
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-muted-foreground">No match</span>
              )}
            </div>
          </div>

          {participantCount > 0 && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">Participants ({participantCount})</p>
              <div className="flex flex-wrap gap-1">
                {msg.participants!.map((p, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {p.name || p.email || "Unknown"}
                    {p.role === "host" && <span className="ml-1 text-indigo-500">(host)</span>}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {msg.review && (
            <div
              className="border border-yellow-300 bg-yellow-50 rounded-lg p-3 space-y-2"
              data-testid={`review-panel-${msg.id}`}
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-yellow-700" />
                <p className="text-sm font-medium text-yellow-900">
                  Needs review — {reviewReasonLabel(msg.review.reviewReason)}
                </p>
              </div>
              {msg.review.explanationSummary && (
                <p className="text-xs text-yellow-800" data-testid={`review-explanation-${msg.id}`}>
                  {msg.review.explanationSummary}
                </p>
              )}
              {msg.review.suggestedClientName && (
                <p className="text-xs text-yellow-800" data-testid={`review-suggested-${msg.id}`}>
                  <span className="font-medium">Top suggestion:</span> {msg.review.suggestedClientName}
                  {msg.review.suggestedConfidence != null && (
                    <span className="ml-1 text-yellow-600">
                      ({Math.round(msg.review.suggestedConfidence * 100)}%)
                    </span>
                  )}
                </p>
              )}
              {msg.review.priorClientName && (
                <p className="text-xs text-yellow-800" data-testid={`review-prior-${msg.id}`}>
                  <span className="font-medium">Was attributed to:</span> {msg.review.priorClientName}
                </p>
              )}
              {msg.review.candidates.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase font-medium text-yellow-700 mb-1">
                    Candidate shortlist
                  </p>
                  <ul className="space-y-1 text-xs">
                    {msg.review.candidates.slice(0, 5).map((c, idx) => (
                      <li
                        key={`${msg.id}-cand-${idx}`}
                        className="flex items-center justify-between bg-card border border-yellow-200 rounded px-2 py-1"
                        data-testid={`review-candidate-${msg.id}-${idx}`}
                      >
                        <span className="text-foreground">
                          {c.clientName || c.clientId || "Unknown client"}
                        </span>
                        <div className="flex items-center gap-2">
                          {c.confidenceScore != null && (
                            <span className="text-muted-foreground">
                              {Math.round(c.confidenceScore * 100)}%
                            </span>
                          )}
                          {c.clientId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 px-1.5 text-[10px] text-yellow-800 hover:bg-yellow-100"
                              disabled={isReviewing}
                              onClick={(e) => {
                                e.stopPropagation();
                                onReviewApprove(msg.review!.decisionId, c.clientId!);
                              }}
                              data-testid={`button-review-route-${msg.id}-${idx}`}
                            >
                              Route here
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {msg.review.suggestedClientId && (
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-yellow-600 hover:bg-yellow-700 text-white"
                    disabled={isReviewing}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReviewApprove(msg.review!.decisionId);
                    }}
                    data-testid={`button-review-accept-${msg.id}`}
                  >
                    {isReviewing ? (
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle className="w-3 h-3 mr-1" />
                    )}
                    Accept suggestion
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-yellow-800 hover:bg-yellow-100"
                  disabled={isReviewing}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReviewDismiss(msg.review!.decisionId);
                  }}
                  data-testid={`button-review-dismiss-${msg.id}`}
                >
                  <X className="w-3 h-3 mr-1" />
                  Leave unattributed
                </Button>
              </div>
            </div>
          )}

          {msg.resolved && (
            <ZoomResolvedPanel msgId={msg.id} resolved={msg.resolved} />
          )}

          <MeetingClientLinks commId={msg.id} />

          {msg.contentText && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">Transcript Preview</p>
              <div className="bg-card border rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                {msg.contentText}
              </div>
            </div>
          )}

          {msg.aiSummary && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">AI Summary</p>
              <p className="text-sm bg-card border rounded p-3">{msg.aiSummary}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            {msg.externalUrl && (
              <a
                href={msg.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                data-testid={`link-zoom-${msg.id}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View Recording
              </a>
            )}

            {msg.googleDriveFileUrl && (
              <a
                href={msg.googleDriveFileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-green-600 hover:underline"
                data-testid={`link-drive-${msg.id}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View in Drive
              </a>
            )}

            <div className="flex-1" />

            {showClientPicker ? (
              <div className="flex items-center gap-2">
                <Select
                  onValueChange={(value) => {
                    const cId = value === "__unmatched__" ? null : value;
                    onReassign(msg.id, cId);
                    setShowClientPicker(false);
                  }}
                >
                  <SelectTrigger className="w-52 h-8 text-sm" data-testid={`select-client-${msg.id}`}>
                    <SelectValue placeholder="Select client..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unmatched__">Mark as Unmatched</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowClientPicker(false)}
                  data-testid={`button-cancel-reassign-${msg.id}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowClientPicker(true)}
                disabled={isReassigning}
                data-testid={`button-reassign-${msg.id}`}
              >
                {isReassigning ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : msg.clientId ? (
                  <ArrowUpDown className="w-3.5 h-3.5 mr-1" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5 mr-1" />
                )}
                {msg.clientId ? "Reassign" : "Match to Client"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type BookingHealthData = {
  bookings: {
    totalLast30Days: number;
    bySource: Array<{ source: string; count: number }>;
    byMatchMethod: Array<{ matchMethod: string | null; count: number }>;
    failed: number;
  };
  accountManagers?: {
    withActivePage: number;
    connectedToCalendar: number;
    missingCalendar: number;
    calendarStatusBreakdown: Record<string, number>;
  };
  zoom?: {
    scopesValid: boolean;
    missingScopes: string[];
    errors: Record<string, string>;
  };
  calendarConfigured: boolean;
};

function BookingHealthPanel() {
  const { data, isLoading } = useQuery<BookingHealthData>({
    queryKey: ["/api/admin/booking/health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/booking/health", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load booking health");
      return res.json();
    },
  });

  return (
    <Card className="mb-6" data-testid="card-booking-health">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Calendar className="w-5 h-5" /> Booking System (last 30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <InlineLoadingSkeleton lines={2} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded border p-3" data-testid="stat-bookings-total">
                <div className="text-xs text-muted-foreground">OS-booked meetings</div>
                <div className="text-2xl font-semibold">{data.bookings.totalLast30Days}</div>
              </div>
              <div className="rounded border p-3" data-testid="stat-bookings-failed">
                <div className="text-xs text-muted-foreground">Failed bookings</div>
                <div className="text-2xl font-semibold">{data.bookings.failed}</div>
              </div>
              <div className="rounded border p-3" data-testid="stat-calendar-configured">
                <div className="text-xs text-muted-foreground">Google Calendar OAuth</div>
                <div className="text-sm font-medium mt-1">
                  {data.calendarConfigured ? (
                    <span className="text-green-600">Configured</span>
                  ) : (
                    <span className="text-amber-600">Not configured</span>
                  )}
                </div>
              </div>
              <div className="rounded border p-3" data-testid="stat-deterministic-matches">
                <div className="text-xs text-muted-foreground">Deterministic matches</div>
                <div className="text-2xl font-semibold">
                  {data.bookings.byMatchMethod.find((m) => m.matchMethod === "booked_in_app")?.count || 0}
                </div>
              </div>
            </div>

            {(data.accountManagers || data.zoom) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {data.accountManagers && (
                  <div
                    className="rounded border p-3"
                    data-testid="card-am-readiness"
                  >
                    <div className="text-sm font-medium mb-2">Account manager readiness</div>
                    <ul className="text-sm space-y-1">
                      <li className="flex justify-between">
                        <span>AMs with an active booking page</span>
                        <span className="font-medium" data-testid="text-ams-with-page">
                          {data.accountManagers.withActivePage}
                        </span>
                      </li>
                      <li className="flex justify-between">
                        <span>AMs connected to Google Calendar</span>
                        <span className="font-medium" data-testid="text-ams-connected">
                          {data.accountManagers.connectedToCalendar}
                        </span>
                      </li>
                      <li className="flex justify-between">
                        <span>AMs with a page but no Calendar</span>
                        <span
                          className={
                            data.accountManagers.missingCalendar > 0
                              ? "font-medium text-amber-600"
                              : "font-medium"
                          }
                          data-testid="text-ams-missing-calendar"
                        >
                          {data.accountManagers.missingCalendar}
                        </span>
                      </li>
                    </ul>
                    {Object.keys(data.accountManagers.calendarStatusBreakdown).length > 0 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Calendar credential states:{" "}
                        {Object.entries(data.accountManagers.calendarStatusBreakdown)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </div>
                    )}
                    <div className="mt-2 text-xs">
                      <a
                        href="/profile?tab=booking"
                        className="underline text-muted-foreground hover:text-foreground"
                        data-testid="link-check-own-booking-settings"
                      >
                        Check your own booking settings
                      </a>
                    </div>
                  </div>
                )}
                {data.zoom && (
                  <div
                    className="rounded border p-3"
                    data-testid="card-zoom-scopes"
                  >
                    <div className="text-sm font-medium mb-2">Zoom OAuth scope readiness</div>
                    <div className="text-sm">
                      Status:{" "}
                      {data.zoom.scopesValid ? (
                        <span className="text-green-600 font-medium" data-testid="text-zoom-scopes-valid">
                          Valid
                        </span>
                      ) : (
                        <span className="text-amber-600 font-medium" data-testid="text-zoom-scopes-invalid">
                          Action required
                        </span>
                      )}
                    </div>
                    {data.zoom.missingScopes.length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs font-medium text-amber-700">
                          Missing scopes
                        </div>
                        <ul className="text-xs list-disc list-inside text-muted-foreground">
                          {data.zoom.missingScopes.map((s) => (
                            <li key={s} data-testid={`text-zoom-missing-${s}`}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {Object.keys(data.zoom.errors).length > 0 && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Last probe errors: {Object.entries(data.zoom.errors).length}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-2">By booking source</div>
                {data.bookings.bySource.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No bookings yet.</div>
                ) : (
                  (() => {
                    const totalSrc = data.bookings.bySource.reduce(
                      (a, b) => a + (b.count || 0),
                      0,
                    );
                    return (
                      <ul className="text-sm space-y-1">
                        {data.bookings.bySource.map((s) => {
                          const pct =
                            totalSrc > 0
                              ? Math.round((s.count / totalSrc) * 1000) / 10
                              : 0;
                          return (
                            <li
                              key={s.source}
                              className="flex justify-between border-b py-1"
                              data-testid={`row-source-${s.source}`}
                            >
                              <span>{s.source}</span>
                              <span className="font-medium">
                                {s.count}
                                <span
                                  className="ml-2 text-xs text-muted-foreground"
                                  data-testid={`pct-source-${s.source}`}
                                >
                                  ({pct}%)
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Recording match method</div>
                {data.bookings.byMatchMethod.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No matches yet.</div>
                ) : (
                  (() => {
                    const totalMatch = data.bookings.byMatchMethod.reduce(
                      (a, b) => a + (b.count || 0),
                      0,
                    );
                    return (
                      <ul className="text-sm space-y-1">
                        {data.bookings.byMatchMethod.map((m) => {
                          const key = m.matchMethod || "unmatched";
                          const pct =
                            totalMatch > 0
                              ? Math.round((m.count / totalMatch) * 1000) / 10
                              : 0;
                          return (
                            <li
                              key={key}
                              className="flex justify-between border-b py-1"
                              data-testid={`row-match-${key}`}
                            >
                              <span>{key}</span>
                              <span className="font-medium">
                                {m.count}
                                <span
                                  className="ml-2 text-xs text-muted-foreground"
                                  data-testid={`pct-match-${key}`}
                                >
                                  ({pct}%)
                                </span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function ZoomIntegration() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  // Task #1033: prefer the user's saved display timezone (explicit pick
  // or seeded from Google Calendar) over the legacy "America/Chicago"
  // fallback, with a final fallback to the browser-detected zone.
  const userTimezone = useDisplayTimezone().timezone;

  const [page, setPage] = useState(1);
  const [matchFilter, setMatchFilter] = useState<string>("all");
  const feedRef = useRef<HTMLDivElement>(null);
  const applyMatchFilter = useCallback((value: string) => {
    setMatchFilter(value);
    setPage(1);
    requestAnimationFrame(() => {
      feedRef.current?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "start" });
    });
  }, []);
  const [hostFilter, setHostFilter] = useState("");
  const [clientIdFilter, setClientIdFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reassigningId, setReassigningId] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading, error: statusError } = useQuery<ZoomStatus>({
    queryKey: ["/api/integrations/zoom/status"],
    // Task #2820 — while the status route reports "status unknown" (transient
    // settings-read blip, Task #2811's 503 contract), keep re-checking so the
    // neutral state resolves itself without a manual reload.
    refetchInterval: (query) =>
      parseIntegrationStatusUnknownError(query.state.error) ? 15_000 : false,
  });
  // Task #2820 — a status-unknown 503 with NO previously-loaded data must
  // render as neutral "checking", never as "Not Connected". When data exists
  // from an earlier success, React Query keeps it across the failed refetch,
  // so the last-known badge continues to render unchanged.
  const statusUnknown = !status && !!parseIntegrationStatusUnknownError(statusError);

  // Task #2216 — pull the Zoom auth-gate breaker detail from the shared
  // all-status endpoint so the dedicated console matches the Integrations Hub.
  const { data: allStatus } = useQuery<{ zoom?: ZoomBreakerStatus }>({
    queryKey: ["/api/integrations/all-status"],
  });
  const zoomBreaker = allStatus?.zoom;

  const { data: reviewQueueData } = useQuery<{ items: Array<{ decision: { id: string } }> }>({
    queryKey: ["/api/admin/zoom/review-queue", { includeResolved: false }],
    queryFn: async () => {
      const res = await fetch("/api/admin/zoom/review-queue?includeResolved=false", {
        credentials: "include",
      });
      if (!res.ok) return { items: [] };
      return res.json();
    },
  });
  const pendingReviewCount = reviewQueueData?.items?.length ?? 0;

  // Task #996: lightweight backlog trend so the header badge tells operators
  // whether the unmatched-Zoom queue is growing or shrinking, without making
  // them open the Review Queue page first.
  const { data: reviewTrend } = useQuery<{
    pendingCount: number;
    pendingCount24hAgo: number;
    pendingCount7dAgo: number;
  }>({
    queryKey: ["/api/admin/zoom/review-queue/trend"],
    queryFn: async () => {
      const res = await fetch("/api/admin/zoom/review-queue/trend", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch trend");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const feedQueryParams = new URLSearchParams();
  feedQueryParams.set("page", String(page));
  feedQueryParams.set("limit", "25");
  if (matchFilter !== "all") feedQueryParams.set("match", matchFilter);
  if (hostFilter) feedQueryParams.set("host", hostFilter);
  if (clientIdFilter !== "all") feedQueryParams.set("clientId", clientIdFilter);
  if (dateFrom) feedQueryParams.set("dateFrom", dateFrom);
  if (dateTo) feedQueryParams.set("dateTo", dateTo);

  const { data: feedData, isLoading: feedLoading } = useQuery<MessageFeedResponse>({
    queryKey: ["/api/integrations/zoom/messages", feedQueryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/zoom/messages?${feedQueryParams.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch meetings");
      return res.json();
    },
    enabled: !!status?.connected,
  });

  const { data: clientsList = [] } = useQuery<ClientOption[]>({
    queryKey: ["/api/clients-list"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) return [];
      const data: { data?: Array<{ id: string; firmName: string }>; } | Array<{ id: string; firmName: string }> = await res.json();
      const list: Array<{ id: string; firmName: string }> = Array.isArray(data) ? data : (data.data || []);
      return list.map((c) => ({ id: c.id, firmName: c.firmName }));
    },
    enabled: !!status?.connected,
  });

  const syncMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await fetch("/api/integrations/zoom/recordings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to trigger Zoom sync");
      return res.json();
    },
    onSuccess: (data: any[]) => {
      toast({
        title: "Zoom sync completed",
        description: `Found ${data.length} recording(s)`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  const [reprocessProgress, setReprocessProgress] = useState<{ current: number; total: number } | null>(null);
  const [reprocessMatchedProgress, setReprocessMatchedProgress] = useState<{ current: number; total: number } | null>(null);

  const startSSEReprocess = useCallback((url: string, onProgress: (p: { current: number; total: number }) => void, onComplete: (data: any) => void, onError: (msg: string) => void) => {
    fetch(url, { method: "POST", credentials: "include" }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        onError(text || response.statusText);
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) { onError("No response stream"); return; }
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          if (!block.trim()) continue;
          let eventType = "";
          let eventData = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            else if (line.startsWith("data: ")) eventData = line.slice(6);
          }
          if (!eventType || !eventData) continue;
          let parsed: any;
          try { parsed = JSON.parse(eventData); } catch { continue; }
          if (eventType === "progress") onProgress(parsed);
          else if (eventType === "complete") settle(() => onComplete(parsed));
          else if (eventType === "error") settle(() => onError(parsed.message || "Unknown error"));
        }
      }
      settle(() => onError("Stream ended unexpectedly"));
    }).catch((err) => {
      onError(err.message || "Network error");
    });
  }, []);

  const reprocessMutation = useMutation({
    mutationFn: () => new Promise<any>((resolve, reject) => {
      toast({ title: "Reprocessing started", description: "Processing dismissed/unmatched records..." });
      setReprocessProgress({ current: 0, total: 0 });
      startSSEReprocess(
        "/api/integrations/zoom/reprocess",
        (p) => setReprocessProgress(p),
        (data) => { setTimeout(() => { setReprocessProgress(null); resolve(data); }, 800); },
        (msg) => { setReprocessProgress(null); reject(new Error(msg)); },
      );
    }),
    onSuccess: (data: any) => {
      toast({
        title: "Reprocessing complete",
        description: `${data.matched} matched, ${data.multiClientLinked} multi-client linked out of ${data.total} records`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Reprocess failed", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const reprocessMatchedMutation = useMutation({
    mutationFn: () => new Promise<any>((resolve, reject) => {
      toast({ title: "Reprocessing started", description: "Processing matched records..." });
      setReprocessMatchedProgress({ current: 0, total: 0 });
      startSSEReprocess(
        "/api/integrations/zoom/reprocess-matched",
        (p) => setReprocessMatchedProgress(p),
        (data) => { setTimeout(() => { setReprocessMatchedProgress(null); resolve(data); }, 800); },
        (msg) => { setReprocessMatchedProgress(null); reject(new Error(msg)); },
      );
    }),
    onSuccess: (data: any) => {
      toast({
        title: "Reprocessing complete",
        description: `${data.rematched} rematched, ${data.changed} changed client out of ${data.total} records`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Reprocess failed", description: err.message, variant: "destructive" });
    },
    meta: { silent: true },
  });

  const [reviewingDecisionId, setReviewingDecisionId] = useState<string | null>(null);

  const reviewApproveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ decisionId, clientId }: { decisionId: string; clientId?: string }) => {
      setReviewingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/approve`, {
        approvedClientId: clientId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Review resolved", description: "Zoom call attribution applied." });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setReviewingDecisionId(null);
    },
    onError: (err: any) => {
      toast({ title: "Approve failed", description: err.message, variant: "destructive" });
      setReviewingDecisionId(null);
    },
  });

  const [dismissTarget, setDismissTarget] = useState<string | null>(null);
  const reviewDismissMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ decisionId, reason, reasonNote }: { decisionId: string; reason: DismissReason; reasonNote?: string }) => {
      setReviewingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/dismiss`, {
        reason,
        reasonNote,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Left unattributed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setReviewingDecisionId(null);
      setDismissTarget(null);
    },
    onError: (err: any) => {
      toast({ title: "Dismiss failed", description: err.message, variant: "destructive" });
      setReviewingDecisionId(null);
    },
  });

  const reassignMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ messageId, clientId }: { messageId: string; clientId: string | null }) => {
      setReassigningId(messageId);
      const res = await apiRequest("PATCH", `/api/integrations/zoom/messages/${messageId}/reassign`, { clientId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Meeting reassigned" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] }); // fire-and-forget: cache refresh only
      setReassigningId(null);
    },
    onError: (err: any) => {
      toast({ title: "Reassignment failed", description: err.message, variant: "destructive" });
      setReassigningId(null);
    },
  });

  const stats = feedData?.stats;
  const messages = feedData?.messages || [];
  const pagination = feedData?.pagination;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <PageHeader
          className="mb-8"
          title="Zoom Meeting Review"
          icon={Video}
          backHref="/admin/integrations"
          backLabel="Integrations"
          backTestId="button-back-integrations"
          subtitle="Review ingested Zoom meetings and manage client matching"
          actions={
          /* flex-wrap + min-w-0: this action group is ~417px wide and cannot
              shrink; without wrapping it drives horizontal page scroll at
              375px (OS mobile layout sweep). Desktop single-line unchanged. */
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/admin/zoom/review")}
              data-testid="button-zoom-review-queue"
            >
              <Inbox className="w-4 h-4 mr-1" />
              Review Queue
              {pendingReviewCount > 0 && (
                <Badge
                  className="ml-2 bg-amber-100 text-amber-800 hover:bg-amber-100"
                  data-testid="badge-zoom-review-queue-count"
                >
                  {pendingReviewCount}
                </Badge>
              )}
              {/* Task #996: 24h backlog trend arrow next to the count so the
                  spike from Task #993's removed AI dismissal is visible at a
                  glance from the Zoom landing page. */}
              {reviewTrend && reviewTrend.pendingCount24hAgo !== reviewTrend.pendingCount && (
                (() => {
                  const delta = reviewTrend.pendingCount - reviewTrend.pendingCount24hAgo;
                  const up = delta > 0;
                  return (
                    <span
                      className={
                        "ml-1.5 inline-flex items-center text-xs font-medium " +
                        (up ? "text-rose-700" : "text-emerald-700")
                      }
                      title={`${up ? "+" : ""}${delta} vs. 24h ago (${reviewTrend.pendingCount24hAgo} → ${reviewTrend.pendingCount})`}
                      data-testid="badge-zoom-review-trend-24h"
                    >
                      {up ? (
                        <TrendingUp className="w-3.5 h-3.5 mr-0.5" />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5 mr-0.5" />
                      )}
                      {up ? `+${delta}` : delta}
                    </span>
                  );
                })()
              )}
            </Button>
            {/* Task #4057: separate manual tool — year-back transcript sweep +
                AI match-guess review workbench. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/admin/zoom/match-assistant")}
              data-testid="button-zoom-match-assistant"
            >
              <Wand2 className="w-4 h-4 mr-1" />
              Transcript Match Assistant
            </Button>
            <Badge
              className={statusUnknown ? "bg-muted text-muted-foreground" : status?.connected ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"}
              data-testid="badge-connection-status"
            >
              {statusUnknown ? "Checking…" : status?.connected ? "Connected" : "Not Connected"}
            </Badge>
          </div>
          }
        />

        <Card className="mb-6" data-testid="card-connection-status">
          <CardHeader>
            <CardTitle className="text-lg">Connection</CardTitle>
          </CardHeader>
          <CardContent>
            {statusLoading ? (
              <InlineLoadingSkeleton lines={2} />
            ) : statusUnknown ? (
              <div className="flex items-center gap-3" data-testid="text-zoom-status-unknown">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">
                  Status check temporarily unavailable — retrying. This is not a disconnect.
                </p>
              </div>
            ) : status?.connected ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <p className="font-medium" data-testid="text-connected">Zoom account connected</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground">
                  Zoom is not connected. Connect via the Integrations Hub to start syncing meetings.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate("/admin/integrations")}
                  data-testid="button-go-integrations"
                >
                  Go to Integrations
                </Button>
              </div>
            )}
            {zoomBreaker?.breakerOpen && (
              <div className="mt-3 space-y-1" data-testid="banner-zoom-breaker">
                <div className="flex items-center gap-1.5 text-sm font-medium text-red-700">
                  <AlertCircle className="w-4 h-4" />
                  Zoom disconnected — reconnect required
                </div>
                <BreakerDetailRow
                  lastTrippedAt={zoomBreaker.lastTrippedAt}
                  cooldownUntil={zoomBreaker.cooldownUntil}
                  selfHealParked={zoomBreaker.selfHealParked}
                  tripCount={zoomBreaker.tripCount}
                  testIdPrefix="zoom"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {status?.connected && <BookingHealthPanel />}

        {status?.connected && (
          <>
            <Card className="mb-6" data-testid="card-sync-control">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Sync Meetings</CardTitle>
                  <Button
                    onClick={() => syncMutation.mutate()}
                    disabled={syncMutation.isPending}
                    data-testid="button-trigger-sync"
                  >
                    {syncMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-1" />
                    )}
                    {syncMutation.isPending ? "Syncing..." : "Sync Now"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-indigo-50 rounded-lg" data-testid="info-sync">
                  <Video className="w-4 h-4 text-indigo-600 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-indigo-800">
                    <p className="font-medium mb-1">Pull recent Zoom recordings</p>
                    <p className="text-indigo-700">
                      Sync fetches recordings from all Zoom account users. Meetings are matched to clients
                      via transcript deep scan first, then participant emails, then agent memory.
                    </p>
                  </div>
                </div>
                <div className="p-3 bg-amber-50 rounded-lg space-y-2">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 text-sm text-amber-800">
                      <p className="font-medium mb-0.5">Reprocess dismissed meetings</p>
                      <p className="text-amber-700">Re-scan all unmatched and previously dismissed meetings with the improved transcript-first matching.</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-300 text-amber-700 hover:bg-amber-100"
                      onClick={() => reprocessMutation.mutate()}
                      disabled={reprocessMutation.isPending}
                      data-testid="button-reprocess-all"
                    >
                      {reprocessMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 mr-1" />
                      )}
                      {reprocessMutation.isPending ? "Reprocessing..." : "Reprocess All"}
                    </Button>
                  </div>
                  {reprocessProgress && (
                    <div className="space-y-1" data-testid="progress-reprocess-all">
                      <Progress value={reprocessProgress.total > 0 ? (reprocessProgress.current / reprocessProgress.total) * 100 : 0} className="h-2" />
                      <p className="text-xs text-amber-700">
                        Processing {reprocessProgress.current} of {reprocessProgress.total} records...
                      </p>
                    </div>
                  )}
                </div>
                <div className="p-3 bg-rose-50 rounded-lg space-y-2">
                  <div className="flex items-center gap-3">
                    <RefreshCw className="w-4 h-4 text-rose-600 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 text-sm text-rose-800">
                      <p className="font-medium mb-0.5">Reprocess matched meetings</p>
                      <p className="text-rose-700">Clear existing matches and re-run matching on all previously matched meetings to fix false positives.</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-rose-300 text-rose-700 hover:bg-rose-100"
                      onClick={() => reprocessMatchedMutation.mutate()}
                      disabled={reprocessMatchedMutation.isPending}
                      data-testid="button-reprocess-matched"
                    >
                      {reprocessMatchedMutation.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 mr-1" />
                      )}
                      {reprocessMatchedMutation.isPending ? "Reprocessing..." : "Reprocess Matched"}
                    </Button>
                  </div>
                  {reprocessMatchedProgress && (
                    <div className="space-y-1" data-testid="progress-reprocess-matched">
                      <Progress value={reprocessMatchedProgress.total > 0 ? (reprocessMatchedProgress.current / reprocessMatchedProgress.total) * 100 : 0} className="h-2" />
                      <p className="text-xs text-rose-700">
                        Processing {reprocessMatchedProgress.current} of {reprocessMatchedProgress.total} records...
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-6" data-testid="stats-summary">
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold" data-testid="stat-total">{stats.total}</p>
                    <p className="text-xs text-muted-foreground">Total Meetings</p>
                  </CardContent>
                </Card>
                <Card
                  role="button"
                  tabIndex={0}
                  aria-pressed={matchFilter === "matched"}
                  onClick={() => applyMatchFilter("matched")}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyMatchFilter("matched"); } }}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 hover:border-green-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 ${matchFilter === "matched" ? "ring-2 ring-green-500" : ""}`}
                  data-testid="card-stat-matched"
                >
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-green-600" data-testid="stat-matched">{stats.matched}</p>
                    <p className="text-xs text-muted-foreground">Matched</p>
                  </CardContent>
                </Card>
                <Card
                  role="button"
                  tabIndex={0}
                  aria-pressed={matchFilter === "unmatched"}
                  onClick={() => applyMatchFilter("unmatched")}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyMatchFilter("unmatched"); } }}
                  className={`cursor-pointer transition-colors hover:bg-muted/50 hover:border-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${matchFilter === "unmatched" ? "ring-2 ring-gray-400" : ""}`}
                  data-testid="card-stat-unmatched"
                >
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-muted-foreground" data-testid="stat-unmatched">{stats.unmatched}</p>
                    <p className="text-xs text-muted-foreground">Unmatched</p>
                  </CardContent>
                </Card>
                <Card
                  role="button"
                  tabIndex={0}
                  aria-pressed={matchFilter === "review"}
                  onClick={() => applyMatchFilter("review")}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); applyMatchFilter("review"); } }}
                  className={`cursor-pointer transition-colors hover:bg-yellow-50 hover:border-yellow-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500 ${matchFilter === "review" ? "ring-2 ring-yellow-500" : ""}`}
                  data-testid="card-stat-needs-review"
                >
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-yellow-600" data-testid="stat-needs-review">{stats.needsReview ?? 0}</p>
                    <p className="text-xs text-muted-foreground">Needs review</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-3 px-4">
                    <p className="text-2xl font-bold text-blue-600" data-testid="stat-match-rate">{stats.matchRate}%</p>
                    <p className="text-xs text-muted-foreground">Match Rate</p>
                  </CardContent>
                </Card>
              </div>
            )}

            <Card ref={feedRef} className="mb-6 scroll-mt-4" data-testid="card-meeting-feed">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-lg">Meeting Review Feed</CardTitle>
                    {pagination && stats && (() => {
                      const filtersActive = matchFilter !== "all" || !!hostFilter || clientIdFilter !== "all" || !!dateFrom || !!dateTo;
                      const filteredTotal = pagination.total;
                      const globalTotal = stats.total;
                      const shownStart = filteredTotal === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
                      const shownEnd = Math.min(pagination.page * pagination.limit, filteredTotal);
                      const range = filteredTotal === 0 ? "0" : `${shownStart}-${shownEnd}`;
                      return filtersActive ? (
                        <button
                          type="button"
                          onClick={() => {
                            setMatchFilter("all");
                            setHostFilter("");
                            setClientIdFilter("all");
                            setDateFrom("");
                            setDateTo("");
                            setPage(1);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 cursor-pointer hover:bg-blue-100 hover:border-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                          data-testid="text-filtered-count"
                          title={`Showing ${range} of ${filteredTotal} filtered (out of ${globalTotal} total) — click to clear filters`}
                        >
                          <Filter className="w-3 h-3" />
                          {range} of {filteredTotal}
                          <span className="text-blue-500/70">/ {globalTotal}</span>
                          <X className="w-3 h-3 ml-0.5" />
                        </button>
                      ) : (
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-muted text-muted-foreground"
                          data-testid="text-filtered-count"
                          title={`Showing ${range} of ${globalTotal}`}
                        >
                          {range} of {globalTotal}
                        </span>
                      );
                    })()}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/integrations/zoom/messages"] })}
                    data-testid="button-refresh-feed"
                  >
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Refresh
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-3 mb-4 p-3 bg-muted/50 rounded-lg" data-testid="filters-bar">
                  <div className="flex items-center gap-1">
                    <Filter className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Filters:</span>
                  </div>

                  <Select
                    value={matchFilter}
                    onValueChange={(v) => { setMatchFilter(v); setPage(1); }}
                  >
                    <SelectTrigger className="w-36 h-8 text-sm" data-testid="filter-match-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Meetings</SelectItem>
                      <SelectItem value="matched">Matched</SelectItem>
                      <SelectItem value="unmatched">Unmatched</SelectItem>
                      <SelectItem value="review">Needs review</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={clientIdFilter}
                    onValueChange={(v) => { setClientIdFilter(v); setPage(1); }}
                  >
                    <SelectTrigger className="w-44 h-8 text-sm" data-testid="filter-client">
                      <SelectValue placeholder="All Clients" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Clients</SelectItem>
                      {clientsList.map((c) => (
                        <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 w-36 pl-7 text-sm"
                      placeholder="Host name..."
                      value={hostFilter}
                      onChange={(e) => { setHostFilter(e.target.value); setPage(1); }}
                      data-testid="filter-host"
                    />
                  </div>

                  <div className="flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={dateFrom}
                      onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                      data-testid="filter-date-from"
                    />
                    <span className="text-muted-foreground text-sm">-</span>
                    <Input
                      type="date"
                      className="h-8 w-36 text-sm"
                      value={dateTo}
                      onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                      data-testid="filter-date-to"
                    />
                  </div>

                  {(matchFilter !== "all" || hostFilter || clientIdFilter !== "all" || dateFrom || dateTo) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setMatchFilter("all");
                        setHostFilter("");
                        setClientIdFilter("all");
                        setDateFrom("");
                        setDateTo("");
                        setPage(1);
                      }}
                      data-testid="button-clear-filters"
                    >
                      <X className="w-3.5 h-3.5 mr-1" />
                      Clear
                    </Button>
                  )}
                </div>

                {feedLoading ? (
                  <InlineLoadingSkeleton lines={5} />
                ) : messages.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-8">
                    No meetings found. {stats?.total === 0 ? "Click Sync Now to pull recordings." : "Try adjusting your filters."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {messages.map((msg) => (
                      <MeetingRow
                        key={msg.id}
                        msg={msg}
                        isExpanded={expandedId === msg.id}
                        onToggle={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
                        clients={clientsList}
                        onReassign={(messageId, clientId) => reassignMutation.mutate({ messageId, clientId })}
                        isReassigning={reassigningId === msg.id}
                        userTimezone={userTimezone}
                        onReviewApprove={(decisionId, clientId) =>
                          reviewApproveMutation.mutate({ decisionId, clientId })
                        }
                        onReviewDismiss={(decisionId) => setDismissTarget(decisionId)}
                        isReviewing={
                          !!msg.review && reviewingDecisionId === msg.review.decisionId
                        }
                      />
                    ))}
                  </div>
                )}

                {pagination && pagination.totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t" data-testid="pagination">
                    <p className="text-sm text-muted-foreground">
                      Page {pagination.page} of {pagination.totalPages}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => setPage(page - 1)}
                        data-testid="button-prev-page"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={page >= pagination.totalPages}
                        onClick={() => setPage(page + 1)}
                        data-testid="button-next-page"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
      <DismissReasonDialog
        open={dismissTarget !== null}
        onOpenChange={(open) => !open && setDismissTarget(null)}
        isPending={reviewDismissMutation.isPending}
        onConfirm={(reason, note) => {
          if (dismissTarget) {
            reviewDismissMutation.mutate({ decisionId: dismissTarget, reason, reasonNote: note });
          }
        }}
      />
    </div>
  );
}
