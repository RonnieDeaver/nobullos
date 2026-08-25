import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, MessageSquare, Mail, Video, FileText, Sparkles,
  Loader2, ChevronDown, ChevronUp, ChevronRight, Check, X, Clock, AlertCircle,
  ExternalLink, Filter, Trash2, Eye
} from "lucide-react";
import { format } from "date-fns";
import ConversationSummaryPanel from "./ConversationSummaryPanel";
import ClientMessaging from "./ClientMessaging";
import { matchMethodLabel, matchMethodColor, matchMethodDetail, friendlyDismissReason } from "@/lib/matchMethod";
import { getZoomTranscriptBadge } from "@shared/zoomTranscript";
import { ZoomFaceSentimentSection } from "./ZoomFaceSentimentSection";

function displayDetail(matchMethod: string | null | undefined): string | null {
  const raw = matchMethodDetail(matchMethod);
  if (raw && typeof matchMethod === "string" && matchMethod.toLowerCase().startsWith("dismissed:")) {
    return friendlyDismissReason(raw);
  }
  return raw;
}

interface RawCommunicationLogProps {
  clientId: string;
  currentUser: { id: string; role: string };
}

type CommRecord = {
  id: string;
  clientId: string;
  sourceType: string;
  sourceSubtype: string | null;
  title: string;
  timestamp: string;
  direction: string | null;
  participantsJson: Array<{ name?: string; email?: string; role?: string }>;
  externalSourceId: string | null;
  externalUrl: string | null;
  contentText: string | null;
  contentPreview: string | null;
  rawPayloadJson: any;
  processingStatus: string;
  transcriptStatus?: string | null;
  aiSummary: string | null;
  aiSignals: any;
  aiProcessedAt: string | null;
  reviewStatus: string;
  hasSuggestions: boolean;
  isTouchpoint: boolean;
  googleDriveFileUrl: string | null;
  clientFileId?: string | null;
  createdAt: string;
  suggestions?: AiSuggestion[];
  composedThreadContent?: string | null;
  threadContentUnavailable?: boolean;
};

type AiSuggestion = {
  id: string;
  clientId: string;
  rawCommunicationRecordId: string;
  destinationType: string;
  suggestedTitle: string;
  suggestedBody: string | null;
  suggestedFieldChangesJson: any;
  confidenceScore: number | null;
  priority: string;
  reasonForRecommendation: string | null;
  citationSnippetsJson: any;
  status: string;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  resultingRecordId: string | null;
  createdAt: string;
};

const sourceIcons: Record<string, any> = {
  slack: MessageSquare,
  front_email: Mail,
  zoom: Video,
  manual: FileText,
};

const sourceLabels: Record<string, string> = {
  slack: "Slack",
  front_email: "Email",
  zoom: "Zoom",
  manual: "Manual",
};

const sourceColors: Record<string, string> = {
  slack: "bg-purple-50 dark:bg-purple-950/25 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-800",
  front_email: "bg-blue-50 dark:bg-blue-950/25 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800",
  zoom: "bg-indigo-50 dark:bg-indigo-950/25 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800",
  manual: "bg-gray-50 text-gray-700 border-gray-200",
};

const directionLabels: Record<string, string> = {
  inbound: "Inbound",
  outbound: "Outbound",
  internal: "Internal",
};

const reviewStatusConfig: Record<string, { label: string; color: string }> = {
  unreviewed: { label: "Unreviewed", color: "bg-gray-100 text-gray-600" },
  suggestions_pending: { label: "Pending Review", color: "bg-amber-100 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300" },
  partially_resolved: { label: "Partially Resolved", color: "bg-blue-100 dark:bg-blue-950/35 text-blue-700 dark:text-blue-300" },
  resolved: { label: "Resolved", color: "bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300" },
  no_updates_needed: { label: "No Updates Needed", color: "bg-gray-100 text-gray-500" },
};

const destinationLabels: Record<string, string> = {
  command_panel: "Command Panel",
  intelligence_feed: "Intelligence Feed",
  action_log: "Action Log",
};

const destinationColors: Record<string, string> = {
  command_panel: "bg-primary/10 text-primary border-primary/20",
  intelligence_feed: "bg-yellow-50 dark:bg-yellow-950/25 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800",
  action_log: "bg-green-50 dark:bg-green-950/25 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800",
};

function ClientLinksSection({ commId }: { commId: string }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: links = [] } = useQuery<Array<{
    id: string;
    clientId: string;
    clientName: string;
    matchMethod: string;
    matchConfidence: number | null;
    isPrimary: boolean;
    status: string;
    relevantSegments: Array<{ timestamp?: string; text?: string; context?: string }> | null;
  }>>({
    queryKey: ["/api/communications", commId, "client-links"],
    queryFn: async () => {
      const res = await fetch(`/api/communications/${commId}/client-links`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const updateLinkMutation = useMutation({
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
    <div data-testid="client-links-section">
      <p className="text-xs font-medium text-gray-500 mb-1">Detected Clients ({links.length})</p>
      <div className="space-y-1.5">
        {links.map(link => (
          <div key={link.id} className="flex items-center gap-2 text-xs bg-blue-50 dark:bg-blue-950/25 rounded border border-blue-200 dark:border-blue-800 px-2.5 py-1.5" data-testid={`client-link-${link.id}`}>
            <Badge variant="outline" className={`text-caption h-4 px-1 ${link.isPrimary ? "bg-indigo-100 dark:bg-indigo-950/35 text-indigo-800 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800" : "bg-gray-100 text-gray-700"}`}>
              {link.isPrimary ? "Primary" : "Also mentioned"}
            </Badge>
            <span className="font-medium text-gray-800">{link.clientName}</span>
            {link.matchConfidence != null && (
              <span className="text-gray-600">{Math.round(link.matchConfidence * 100)}%</span>
            )}
            <Badge variant="outline" className={`text-caption h-4 px-1 ${matchMethodColor(link.matchMethod)}`} data-testid={`badge-link-method-${link.id}`}>
              {matchMethodLabel(link.matchMethod)}
            </Badge>
            {displayDetail(link.matchMethod) && (
              <span className="text-gray-600 truncate max-w-[160px]" title={displayDetail(link.matchMethod) ?? undefined}>
                {displayDetail(link.matchMethod)}
              </span>
            )}
            {link.relevantSegments && link.relevantSegments.length > 0 && (
              <span className="text-gray-600 truncate max-w-[200px]" title={link.relevantSegments.map(s => s.text).join(", ")}>
                {link.relevantSegments.length} mention{link.relevantSegments.length !== 1 ? "s" : ""}
              </span>
            )}
            <div className="flex-1" />
            {link.status === "detected" && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-caption text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-950/25"
                  onClick={(e) => { e.stopPropagation(); updateLinkMutation.mutate({ linkId: link.id, status: "confirmed" }); }}
                  disabled={updateLinkMutation.isPending}
                  data-testid={`button-confirm-link-${link.id}`}
                >
                  <Check className="w-3 h-3 mr-0.5" /> Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-caption text-red-500 hover:text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/25"
                  onClick={(e) => { e.stopPropagation(); updateLinkMutation.mutate({ linkId: link.id, status: "rejected" }); }}
                  disabled={updateLinkMutation.isPending}
                  data-testid={`button-reject-link-${link.id}`}
                >
                  <X className="w-3 h-3 mr-0.5" /> Reject
                </Button>
              </div>
            )}
            {link.status === "confirmed" && (
              <Badge variant="outline" className="text-caption h-4 px-1 bg-green-50 dark:bg-green-950/25 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800">Confirmed</Badge>
            )}
            {link.status === "rejected" && (
              <Badge variant="outline" className="text-caption h-4 px-1 bg-red-50 dark:bg-red-950/25 text-red-500 border-red-200 dark:border-red-800">Rejected</Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RawCommunicationLog({ clientId, currentUser }: RawCommunicationLogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [reviewFilter, setReviewFilter] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest">("newest");
  const [showFilters, setShowFilters] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);

  const [newTitle, setNewTitle] = useState("");
  const [newSourceType, setNewSourceType] = useState("manual");
  const [newDirection, setNewDirection] = useState("internal");
  const [newContent, setNewContent] = useState("");
  const [newParticipants, setNewParticipants] = useState("");

  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");


  // "sms" is a client-side pseudo-source: SMS threads come from Twilio, not
  // raw_communication_records, so it is never sent to the communications API.
  const showSms = sourceFilter === "all" || sourceFilter === "sms";
  const showCommRecords = sourceFilter !== "sms";

  const queryParams = new URLSearchParams();
  if (searchTerm) queryParams.set("search", searchTerm);
  if (sourceFilter !== "all" && sourceFilter !== "sms") queryParams.set("sourceType", sourceFilter);
  if (reviewFilter !== "all") queryParams.set("reviewStatus", reviewFilter);

  const { data: communications = [], isLoading } = useQuery<CommRecord[]>({
    queryKey: ["/api/clients", clientId, "communications", searchTerm, sourceFilter, reviewFilter],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/clients/${clientId}/communications?${queryParams.toString()}`);
      return res.json();
    },
    enabled: showCommRecords,
  });

  const sortedCommunications = useMemo(() => {
    const ts = (c: CommRecord) => new Date(c.timestamp).getTime();
    return [...communications].sort((a, b) =>
      sortOrder === "oldest" ? ts(a) - ts(b) : ts(b) - ts(a),
    );
  }, [communications, sortOrder]);

  const { data: selectedRecord } = useQuery<CommRecord>({
    queryKey: ["/api/clients", clientId, "communications", selectedRecordId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/clients/${clientId}/communications/${selectedRecordId}`);
      return res.json();
    },
    enabled: !!selectedRecordId,
  });

  const { data: pendingCount } = useQuery<{ count: number }>({
    queryKey: ["/api/clients", clientId, "suggestions", "count"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/clients/${clientId}/suggestions/count`);
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", `/api/clients/${clientId}/communications`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications"] }); // fire-and-forget: cache refresh only
      setShowAddForm(false);
      setNewTitle("");
      setNewContent("");
      setNewParticipants("");
      toast({ title: "Communication record created" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const analyzeMutation = useMutation({
    mutationFn: async (commId: string) => {
      const res = await apiRequest("POST", `/api/clients/${clientId}/communications/${commId}/analyze`);
      return res.json();
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "suggestions"] }); // fire-and-forget: cache refresh only
      if (selectedRecordId) {
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications", selectedRecordId] }); // fire-and-forget: cache refresh only
      }
      const sugCount = data?.suggestions?.length || 0;
      toast({ title: sugCount > 0 ? `Analysis complete — ${sugCount} suggestion${sugCount > 1 ? "s" : ""} generated` : "Analysis complete — no updates needed" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (commId: string) => {
      await apiRequest("DELETE", `/api/clients/${clientId}/communications/${commId}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications"] }); // fire-and-forget: cache refresh only
      setSelectedRecordId(null);
      toast({ title: "Communication deleted" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const reviewSuggestionMutation = useMutation({
    mutationFn: async ({ suggestionId, action, editedTitle, editedBody }: {
      suggestionId: string; action: string; editedTitle?: string; editedBody?: string;
    }) => {
      const res = await apiRequest("PATCH", `/api/clients/${clientId}/suggestions/${suggestionId}`, {
        action, editedTitle, editedBody,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "suggestions"] }); // fire-and-forget: cache refresh only
      if (selectedRecordId) {
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications", selectedRecordId] }); // fire-and-forget: cache refresh only
      }
      setEditingSuggestionId(null);
      toast({ title: "Suggestion updated" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    const participants = newParticipants.trim()
      ? newParticipants.split(",").map(p => ({ name: p.trim() }))
      : undefined;
    createMutation.mutate({
      sourceType: newSourceType,
      sourceSubtype: newSourceType === "manual" ? "manual_note" : undefined,
      title: newTitle.trim(),
      direction: newDirection,
      contentText: newContent.trim() || undefined,
      participantsJson: participants,
    });
  };

  return (
    <div className="space-y-4" data-testid="raw-communication-log">
      <ConversationSummaryPanel clientId={clientId} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-foreground" data-testid="text-comm-log-title">Raw Communication Log</h3>
          {pendingCount && pendingCount.count > 0 && (
            <Badge className="bg-amber-100 dark:bg-amber-950/35 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800" data-testid="badge-pending-suggestions">
              {pendingCount.count} pending
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowFilters(!showFilters)} data-testid="button-toggle-filters">
            <Filter className="w-3 h-3 mr-1" /> Filters
          </Button>
          <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => setShowAddForm(true)} data-testid="button-add-communication">
            <Plus className="w-3 h-3 mr-1" /> Add Record
          </Button>
        </div>
      </div>

      {showFilters && (
        <Card className="border-gray-200" data-testid="comm-filters-panel">
          <CardContent className="pt-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-gray-500 mb-1 block">Search</label>
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-3 w-3 text-gray-400" />
                  <Input
                    placeholder="Search communications..."
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                    className="pl-7 h-8 text-sm"
                    data-testid="input-comm-search"
                  />
                </div>
              </div>
              <div className="w-[140px]">
                <label className="text-xs text-gray-500 mb-1 block">Source</label>
                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-source-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="front_email">Email</SelectItem>
                    <SelectItem value="zoom">Zoom</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[140px]">
                <label className="text-xs text-gray-500 mb-1 block">Sort</label>
                <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as "newest" | "oldest")}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-sort-order">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest First</SelectItem>
                    <SelectItem value="oldest">Oldest First</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-[160px]">
                <label className="text-xs text-gray-500 mb-1 block">Review Status</label>
                <Select value={reviewFilter} onValueChange={setReviewFilter}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-review-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="suggestions_pending">Pending Review</SelectItem>
                    <SelectItem value="partially_resolved">Partially Resolved</SelectItem>
                    <SelectItem value="unreviewed">Unreviewed</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="no_updates_needed">No Updates Needed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {showAddForm && (
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/25" data-testid="add-communication-form">
          <CardContent className="pt-4 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Source Type</label>
                <Select value={newSourceType} onValueChange={setNewSourceType}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-new-source-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual Note</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="front_email">Email</SelectItem>
                    <SelectItem value="zoom">Zoom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Direction</label>
                <Select value={newDirection} onValueChange={setNewDirection}>
                  <SelectTrigger className="h-8 text-sm" data-testid="select-new-direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbound">Inbound</SelectItem>
                    <SelectItem value="outbound">Outbound</SelectItem>
                    <SelectItem value="internal">Internal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Participants</label>
                <Input
                  placeholder="comma-separated names"
                  value={newParticipants}
                  onChange={e => setNewParticipants(e.target.value)}
                  className="h-8 text-sm"
                  data-testid="input-new-participants"
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">Title / Subject</label>
              <Input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="e.g., Monthly strategy call with client"
                className="text-sm"
                data-testid="input-new-title"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">Content / Transcript / Notes</label>
              <Textarea
                value={newContent}
                onChange={e => setNewContent(e.target.value)}
                placeholder="Paste the full communication content, transcript, or meeting notes here..."
                rows={6}
                className="text-sm"
                data-testid="input-new-content"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" className="bg-primary hover:bg-primary/90"
                disabled={!newTitle.trim() || createMutation.isPending}
                onClick={handleCreate}
                data-testid="button-submit-communication">
                {createMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                Create Record
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setShowAddForm(false); setNewTitle(""); setNewContent(""); setNewParticipants(""); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showSms && (
        <div data-testid="section-sms-history">
          <ClientMessaging clientId={clientId} sortOrder={sortOrder} />
        </div>
      )}

      {!showCommRecords ? null : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : communications.length === 0 ? (
        <Card className="border-dashed border-gray-300" data-testid="empty-comm-state">
          <CardContent className="py-12 text-center">
            <MessageSquare className="w-10 h-10 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500 font-medium mb-1">No communications recorded yet</p>
            <p className="text-sm text-gray-400 mb-4">
              Add communication records manually or use the Integrations Hub to set up auto-ingestion from Slack, Front, and Zoom.
            </p>
            <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => setShowAddForm(true)}>
              <Plus className="w-3 h-3 mr-1" /> Add First Record
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedCommunications.map(comm => {
            const SourceIcon = sourceIcons[comm.sourceType] || FileText;
            const reviewConfig = reviewStatusConfig[comm.reviewStatus] || reviewStatusConfig.unreviewed;
            return (
              <Card
                key={comm.id}
                className={`border-gray-200 cursor-pointer transition-colors hover:border-primary/30 ${selectedRecordId === comm.id ? "border-primary/50 bg-primary/5" : ""}`}
                onClick={() => setSelectedRecordId(selectedRecordId === comm.id ? null : comm.id)}
                data-testid={`card-comm-${comm.id}`}
              >
                <CardContent className="py-3 px-4">
                  <div className="flex items-start gap-3">
                    <div className={`p-1.5 rounded ${sourceColors[comm.sourceType] || "bg-gray-50"}`}>
                      <SourceIcon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm truncate" data-testid={`text-comm-title-${comm.id}`}>{comm.title}</span>
                        <Badge variant="outline" className={`text-caption h-4 px-1 shrink-0 ${sourceColors[comm.sourceType]}`}>
                          {sourceLabels[comm.sourceType] || comm.sourceType}
                        </Badge>
                        {comm.isTouchpoint && (
                          <Badge variant="outline" className="text-caption h-4 px-1 shrink-0 bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" data-testid={`badge-touchpoint-${comm.id}`}>
                            Touchpoint
                          </Badge>
                        )}
                        {comm.direction && (
                          <Badge variant="outline" className="text-caption h-4 px-1 shrink-0">
                            {directionLabels[comm.direction] || comm.direction}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <span>{format(new Date(comm.timestamp), "MMM d, yyyy h:mm a")}</span>
                        {comm.participantsJson && Array.isArray(comm.participantsJson) && comm.participantsJson.length > 0 && (
                          <span className="truncate">
                            {comm.participantsJson.map((p: any) => p.name || p.email || p).join(", ")}
                          </span>
                        )}
                      </div>
                      {comm.contentPreview && (
                        <p className="text-xs text-gray-400 mt-1 line-clamp-1">{comm.contentPreview}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {comm.processingStatus === "processing" && (
                        <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                      )}
                      {/* Task #4025: in-app copy is the primary link; Drive
                          stays as a legacy reference for older rows. */}
                      {comm.clientFileId && comm.clientId && (
                        <a
                          href={`/clients/${comm.clientId}?tab=files&file=${comm.clientFileId}`}
                          className="text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center gap-0.5 text-caption"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`link-client-file-${comm.id}`}
                        >
                          <ExternalLink className="w-3 h-3" /> File
                        </a>
                      )}
                      {comm.googleDriveFileUrl && (
                        <a
                          href={comm.googleDriveFileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 flex items-center gap-0.5 text-caption"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`link-drive-${comm.id}`}
                        >
                          <ExternalLink className="w-3 h-3" /> Drive
                        </a>
                      )}
                      {comm.hasSuggestions && (
                        <Badge variant="outline" className="text-caption h-4 px-1 bg-amber-50 dark:bg-amber-950/25 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800">
                          <Sparkles className="w-2.5 h-2.5 mr-0.5" /> suggestions
                        </Badge>
                      )}
                      <Badge className={`text-caption h-4 px-1 ${reviewConfig.color}`}>
                        {reviewConfig.label}
                      </Badge>
                      {selectedRecordId === comm.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!selectedRecordId && !!selectedRecord} onOpenChange={(open) => { if (!open) setSelectedRecordId(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="comm-detail-dialog">
          {selectedRecord && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2 mb-1">
                  {(() => {
                    const SourceIcon = sourceIcons[selectedRecord.sourceType] || FileText;
                    return (
                      <div className={`p-1.5 rounded ${sourceColors[selectedRecord.sourceType]}`}>
                        <SourceIcon className="w-4 h-4" />
                      </div>
                    );
                  })()}
                  <DialogTitle className="text-lg" data-testid="text-detail-title">{selectedRecord.title}</DialogTitle>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
                  <Badge variant="outline" className={`text-caption ${sourceColors[selectedRecord.sourceType]}`}>
                    {sourceLabels[selectedRecord.sourceType]}
                  </Badge>
                  {selectedRecord.isTouchpoint && (
                    <Badge variant="outline" className="text-caption bg-emerald-50 dark:bg-emerald-950/25 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800" data-testid="badge-detail-touchpoint">
                      Touchpoint
                    </Badge>
                  )}
                  {selectedRecord.direction && (
                    <Badge variant="outline" className="text-caption">{directionLabels[selectedRecord.direction]}</Badge>
                  )}
                  <span>{format(new Date(selectedRecord.timestamp), "MMM d, yyyy h:mm a")}</span>
                  {selectedRecord.externalUrl && (
                    <a href={selectedRecord.externalUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline flex items-center gap-0.5">
                      <ExternalLink className="w-3 h-3" /> Source
                    </a>
                  )}
                </div>
              </DialogHeader>

              <div className="space-y-4 mt-2">
                {selectedRecord.participantsJson && Array.isArray(selectedRecord.participantsJson) && selectedRecord.participantsJson.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Participants</p>
                    <div className="flex flex-wrap gap-1">
                      {selectedRecord.participantsJson.map((p: any, i: number) => (
                        <Badge key={i} variant="outline" className="text-xs">{p.name || p.email || p}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {selectedRecord.sourceType === "zoom" && selectedRecord.rawPayloadJson && (
                  <div data-testid="zoom-metadata">
                    <p className="text-xs font-medium text-gray-500 mb-1">Zoom Meeting Details</p>
                    <div className="bg-indigo-50 dark:bg-indigo-950/25 rounded border border-indigo-200 dark:border-indigo-800 p-3 text-sm space-y-1">
                      {(selectedRecord.rawPayloadJson as any).duration > 0 && (
                        <div className="flex items-center gap-2">
                          <Clock className="w-3 h-3 text-indigo-500" />
                          <span className="text-gray-700">{(selectedRecord.rawPayloadJson as any).duration} minutes</span>
                        </div>
                      )}
                      {(selectedRecord.rawPayloadJson as any).hostName && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Host:</span>
                          <span className="text-gray-700">{(selectedRecord.rawPayloadJson as any).hostName} ({(selectedRecord.rawPayloadJson as any).hostEmail})</span>
                        </div>
                      )}
                      {(selectedRecord.rawPayloadJson as any).recordingCount > 0 && (
                        <div className="flex items-center gap-2">
                          <Video className="w-3 h-3 text-indigo-500" />
                          <span className="text-gray-700">{(selectedRecord.rawPayloadJson as any).recordingCount} recording file{(selectedRecord.rawPayloadJson as any).recordingCount !== 1 ? "s" : ""}</span>
                        </div>
                      )}
                      {(() => {
                        // Task #3689: badge driven by transcriptStatus, not the
                        // bare hasTranscript boolean — distinguishes "still
                        // processing" from "Zoom is never going to send one".
                        const zoomBadge = getZoomTranscriptBadge({
                          transcriptStatus: selectedRecord.transcriptStatus ?? null,
                          hasTranscript: !!(selectedRecord.rawPayloadJson as any).hasTranscript,
                          unavailableInfo: (selectedRecord.rawPayloadJson as any).zoomTranscriptUnavailable ?? null,
                          // Task #3701: provenance — a Rev AI-generated
                          // transcript must not read as Zoom-delivered.
                          transcriptSource: (selectedRecord.rawPayloadJson as any).transcriptSource ?? null,
                        });
                        return (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-caption ${zoomBadge.className}`} data-testid="badge-zoom-transcript">
                                {zoomBadge.label}
                              </Badge>
                            </div>
                            {zoomBadge.detail && (
                              <p className="text-[11px] text-gray-500 leading-snug" data-testid="text-zoom-transcript-detail">
                                {zoomBadge.detail}
                              </p>
                            )}
                          </div>
                        );
                      })()}
                      {selectedRecord.externalUrl && (
                        <a href={selectedRecord.externalUrl} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 text-xs" data-testid="link-zoom-recording">
                          <ExternalLink className="w-3 h-3" /> View Recording
                        </a>
                      )}
                      {/* Task #3702: AI-derived client face-sentiment read (renders
                          nothing until the background analyzer stores a result). */}
                      <ZoomFaceSentimentSection result={(selectedRecord.rawPayloadJson as any).zoomFaceSentiment ?? null} />
                      {/* Task #4025: in-app copy first; Drive demoted to legacy. */}
                      {selectedRecord.clientFileId && selectedRecord.clientId && (
                        <a href={`/clients/${selectedRecord.clientId}?tab=files&file=${selectedRecord.clientFileId}`} className="text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 text-xs" data-testid="link-client-file">
                          <ExternalLink className="w-3 h-3" /> View in Files
                        </a>
                      )}
                      {selectedRecord.googleDriveFileUrl && (
                        <a href={selectedRecord.googleDriveFileUrl} target="_blank" rel="noreferrer" className="text-green-600 dark:text-green-400 hover:underline flex items-center gap-1 text-xs" data-testid="link-google-drive">
                          <ExternalLink className="w-3 h-3" /> View in Drive{selectedRecord.clientFileId ? " (legacy)" : ""}
                        </a>
                      )}
                    </div>
                  </div>
                )}

                {selectedRecord.sourceType === "zoom" && (
                  <ClientLinksSection commId={selectedRecord.id} />
                )}

                {selectedRecord.contentText && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">
                      {selectedRecord.sourceType === "zoom" && selectedRecord.sourceSubtype === "zoom_transcript" ? "Transcript" : "Full Content"}
                    </p>
                    <div className="bg-gray-50 rounded border p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto" data-testid="text-comm-content">
                      {selectedRecord.contentText}
                    </div>
                  </div>
                )}

                {!selectedRecord.contentText && selectedRecord.composedThreadContent && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                      Full Content
                      <span className="text-caption text-gray-400 font-normal">(composed from thread messages)</span>
                    </p>
                    <div className="bg-gray-50 rounded border p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto" data-testid="text-comm-content">
                      {selectedRecord.composedThreadContent}
                    </div>
                  </div>
                )}

                {!selectedRecord.contentText && !selectedRecord.composedThreadContent && selectedRecord.threadContentUnavailable && (
                  <div className="flex items-start gap-2 text-xs text-gray-500 bg-amber-50 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-800 rounded p-3" data-testid="notice-content-unavailable">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <span>
                      Email body has not been synced yet.
                      {selectedRecord.externalUrl && (
                        <> <a href={selectedRecord.externalUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">View in Front</a> to read the full message.</>
                      )}
                    </span>
                  </div>
                )}

                {selectedRecord.aiSummary && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" /> AI Summary
                    </p>
                    <div className="bg-purple-50 dark:bg-purple-950/25 rounded border border-purple-200 dark:border-purple-800 p-3 text-sm" data-testid="text-ai-summary">
                      {selectedRecord.aiSummary}
                    </div>
                  </div>
                )}

                {selectedRecord.aiSignals && Array.isArray(selectedRecord.aiSignals) && selectedRecord.aiSignals.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Extracted Signals</p>
                    <div className="space-y-1">
                      {selectedRecord.aiSignals.map((signal: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <Badge variant="outline" className={`text-caption shrink-0 ${
                            signal.relevance === "high" ? "bg-red-50 dark:bg-red-950/25 text-red-600 dark:text-red-400" :
                            signal.relevance === "medium" ? "bg-amber-50 dark:bg-amber-950/25 text-amber-600 dark:text-amber-400" :
                            "bg-gray-50 text-gray-500"
                          }`}>
                            {signal.type?.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-gray-600">{signal.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <CommAgentDecisions communicationId={selectedRecord.id} externalSourceId={selectedRecord.externalSourceId} />

                <div className="flex items-center gap-2">
                  {selectedRecord.processingStatus !== "processed" && (
                    <Button size="sm" variant="outline"
                      disabled={analyzeMutation.isPending || selectedRecord.processingStatus === "processing"}
                      onClick={(e) => { e.stopPropagation(); analyzeMutation.mutate(selectedRecord.id); }}
                      data-testid="button-analyze-comm">
                      {analyzeMutation.isPending || selectedRecord.processingStatus === "processing"
                        ? <Loader2 className="w-3 h-3 animate-spin mr-1" />
                        : <Sparkles className="w-3 h-3 mr-1" />}
                      {selectedRecord.processingStatus === "processed" ? "Re-analyze" : "Run AI Analysis"}
                    </Button>
                  )}
                  {selectedRecord.processingStatus === "processed" && (
                    <Button size="sm" variant="outline"
                      disabled={analyzeMutation.isPending}
                      onClick={(e) => { e.stopPropagation(); analyzeMutation.mutate(selectedRecord.id); }}
                      data-testid="button-reanalyze-comm">
                      {analyzeMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Sparkles className="w-3 h-3 mr-1" />}
                      Re-analyze
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700 dark:text-red-300 dark:hover:text-red-300"
                    disabled={deleteMutation.isPending}
                    onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(selectedRecord.id); }}
                    data-testid="button-delete-comm">
                    <Trash2 className="w-3 h-3 mr-1" /> Delete
                  </Button>
                </div>

                {selectedRecord.suggestions && selectedRecord.suggestions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Suggested Updates ({selectedRecord.suggestions.length})
                    </p>
                    <div className="space-y-2">
                      {selectedRecord.suggestions.map((suggestion) => (
                        <SuggestionCard
                          key={suggestion.id}
                          suggestion={suggestion}
                          editingSuggestionId={editingSuggestionId}
                          editTitle={editTitle}
                          editBody={editBody}
                          setEditingSuggestionId={setEditingSuggestionId}
                          setEditTitle={setEditTitle}
                          setEditBody={setEditBody}
                          onReview={(action, editedTitle, editedBody) => {
                            reviewSuggestionMutation.mutate({
                              suggestionId: suggestion.id,
                              action,
                              editedTitle,
                              editedBody,
                            });
                          }}
                          isPending={reviewSuggestionMutation.isPending}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}

function SuggestionCard({
  suggestion,
  editingSuggestionId,
  editTitle,
  editBody,
  setEditingSuggestionId,
  setEditTitle,
  setEditBody,
  onReview,
  isPending,
}: {
  suggestion: AiSuggestion;
  editingSuggestionId: string | null;
  editTitle: string;
  editBody: string;
  setEditingSuggestionId: (id: string | null) => void;
  setEditTitle: (v: string) => void;
  setEditBody: (v: string) => void;
  onReview: (action: string, editedTitle?: string, editedBody?: string) => void;
  isPending: boolean;
}) {
  const isEditing = editingSuggestionId === suggestion.id;
  const isResolved = !["pending", "snoozed"].includes(suggestion.status);

  return (
    <Card className={`border ${isResolved ? "opacity-60" : "border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/25"}`} data-testid={`card-suggestion-${suggestion.id}`}>
      <CardContent className="py-3 px-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className={`text-caption ${destinationColors[suggestion.destinationType]}`}>
                {destinationLabels[suggestion.destinationType]}
              </Badge>
              <Badge variant="outline" className={`text-caption ${
                suggestion.priority === "urgent" ? "bg-red-50 dark:bg-red-950/25 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800" :
                suggestion.priority === "normal" ? "bg-blue-50 dark:bg-blue-950/25 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800" :
                "bg-gray-50 text-gray-500"
              }`}>
                {suggestion.priority}
              </Badge>
              {suggestion.confidenceScore !== null && (
                <span className="text-caption text-gray-400">
                  {Math.round(suggestion.confidenceScore * 100)}% confidence
                </span>
              )}
              {isResolved && (
                <Badge className={`text-caption ${
                  suggestion.status === "approved" || suggestion.status === "edited_and_approved" ? "bg-green-100 dark:bg-green-950/35 text-green-700 dark:text-green-300" :
                  suggestion.status === "rejected" ? "bg-red-100 dark:bg-red-950/35 text-red-600 dark:text-red-400" :
                  "bg-gray-100 text-gray-500"
                }`}>
                  {suggestion.status.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
            {isEditing ? (
              <div className="space-y-2">
                <Input
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="text-sm h-8"
                  data-testid={`input-edit-suggestion-title-${suggestion.id}`}
                />
                <Textarea
                  value={editBody}
                  onChange={e => setEditBody(e.target.value)}
                  rows={3}
                  className="text-sm"
                  data-testid={`input-edit-suggestion-body-${suggestion.id}`}
                />
              </div>
            ) : (
              <>
                <p className="text-sm font-medium">{suggestion.suggestedTitle}</p>
                {suggestion.suggestedBody && (
                  <p className="text-xs text-gray-600 mt-1">{suggestion.suggestedBody}</p>
                )}
              </>
            )}
          </div>
        </div>

        {suggestion.reasonForRecommendation && (
          <p className="text-caption text-gray-400 italic">{suggestion.reasonForRecommendation}</p>
        )}

        {suggestion.citationSnippetsJson && Array.isArray(suggestion.citationSnippetsJson) && suggestion.citationSnippetsJson.length > 0 && (
          <div className="text-caption text-gray-400">
            {suggestion.citationSnippetsJson.map((snippet: string, i: number) => (
              <p key={i} className="border-l-2 border-gray-200 pl-2 py-0.5">"{snippet}"</p>
            ))}
          </div>
        )}

        {!isResolved && (
          <div className="flex items-center gap-1 pt-1">
            {isEditing ? (
              <>
                <Button size="sm" variant="outline" className="h-6 text-xs text-green-700 dark:text-green-300 border-green-300 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-950/25"
                  disabled={isPending}
                  onClick={() => onReview("edit_and_approve", editTitle, editBody)}
                  data-testid={`button-save-edit-suggestion-${suggestion.id}`}>
                  <Check className="w-3 h-3 mr-0.5" /> Save & Approve
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs"
                  onClick={() => setEditingSuggestionId(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="outline" className="h-6 text-xs text-green-700 dark:text-green-300 border-green-300 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-950/25"
                  disabled={isPending}
                  onClick={() => onReview("approve")}
                  data-testid={`button-approve-${suggestion.id}`}>
                  <Check className="w-3 h-3 mr-0.5" /> Approve
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-xs"
                  onClick={() => {
                    setEditingSuggestionId(suggestion.id);
                    setEditTitle(suggestion.suggestedTitle);
                    setEditBody(suggestion.suggestedBody || "");
                  }}
                  data-testid={`button-edit-suggestion-${suggestion.id}`}>
                  Edit & Approve
                </Button>
                <Button size="sm" variant="outline" className="h-6 text-xs text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/25"
                  disabled={isPending}
                  onClick={() => onReview("reject")}
                  data-testid={`button-reject-${suggestion.id}`}>
                  <X className="w-3 h-3 mr-0.5" /> Reject
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs text-gray-500"
                  disabled={isPending}
                  onClick={() => onReview("snooze")}
                  data-testid={`button-snooze-${suggestion.id}`}>
                  <Clock className="w-3 h-3 mr-0.5" /> Snooze
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type AgentDecision = {
  id: string;
  clientId: string;
  confidenceScore: number;
  status: string;
  explanationSummary: string;
  evidenceType: string;
  correctedByHuman: boolean;
  correctedToClientId: string | null;
};

function CommAgentDecisions({ communicationId, externalSourceId }: { communicationId: string; externalSourceId: string | null }) {
  const { data: decisions = [] } = useQuery<AgentDecision[]>({
    queryKey: [`/api/agent-decisions`, communicationId, externalSourceId],
    queryFn: async () => {
      const results: AgentDecision[] = [];
      const seen = new Set<string>();
      const res1 = await fetch(`/api/agent-decisions?communicationId=${communicationId}`);
      if (res1.ok) {
        const d1: AgentDecision[] = await res1.json();
        for (const d of d1) { results.push(d); seen.add(d.id); }
      }
      if (externalSourceId && externalSourceId !== communicationId) {
        const res2 = await fetch(`/api/agent-decisions?communicationId=${externalSourceId}`);
        if (res2.ok) {
          const d2: AgentDecision[] = await res2.json();
          for (const d of d2) { if (!seen.has(d.id)) results.push(d); }
        }
      }
      return results;
    },
    enabled: !!communicationId,
  });

  if (decisions.length === 0) return null;

  return (
    <div data-testid="comm-agent-decisions">
      <p className="text-xs font-medium text-gray-500 mb-1">Agent Match Decisions</p>
      <div className="space-y-1">
        {decisions.slice(0, 5).map((d) => (
          <div key={d.id} className="flex items-center gap-2 text-xs" data-testid={`agent-decision-${d.id}`}>
            <Badge variant="outline" className={`text-caption ${
              d.status === "claimed" ? "bg-green-50 dark:bg-green-950/25 text-green-700 dark:text-green-300" :
              d.status === "ambiguous" ? "bg-amber-50 dark:bg-amber-950/25 text-amber-700 dark:text-amber-300" :
              "bg-gray-50 text-gray-500"
            }`}>
              {d.status}
            </Badge>
            <span className="font-medium">{(d.confidenceScore * 100).toFixed(0)}%</span>
            <span className="text-gray-500 truncate">{d.explanationSummary}</span>
            {d.correctedByHuman && (
              <Badge variant="outline" className="text-caption bg-purple-50 dark:bg-purple-950/25 text-purple-700 dark:text-purple-300">corrected</Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
