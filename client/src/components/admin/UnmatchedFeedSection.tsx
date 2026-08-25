import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch, Link } from "wouter";
import {
  Mail,
  MessageSquare,
  Video,
  CheckCircle,
  RefreshCw,
  Ban,
  UserPlus,
  Loader2,
  ExternalLink,
  FileText,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Filter,
  RotateCcw,
  Trash2,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { apiRequest } from "@/lib/queryClient";
import { logActivity } from "@/hooks/use-activity-tracker";
import { reviewReasonLabel } from "@/lib/matchMethod";
import { DismissReasonDialog } from "@/components/DismissReasonDialog";
import { type DismissReason } from "@shared/schema";
import { SuggestRulesDialog } from "@/components/admin/front/SuggestRulesDialog";

type ReviewCandidate = {
  clientId: string | null;
  clientName: string | null;
  confidenceScore: number | null;
  evidenceType: string | null;
  explanationSummary: string | null;
};

type ReviewInfo = {
  decisionId: string;
  reviewReason: string | null;
  explanationSummary: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  suggestedConfidence: number | null;
  priorClientId: string | null;
  priorClientName: string | null;
  candidates: ReviewCandidate[];
  reopenedAt?: string | null;
  reopenedByUserId?: string | null;
  reopenedByName?: string | null;
  reopenedByEmail?: string | null;
  reopenCount?: number;
};

type UnmatchedItem = {
  id: string;
  source: "front" | "slack" | "zoom";
  title: string;
  snippet: string;
  contentText: string | null;
  aiSummary: string | null;
  participants: string[];
  participantsRaw: Array<{ name?: string; email?: string; role?: string }>;
  timestamp: string | null;
  suggestedClientId: string | null;
  suggestedClientName: string | null;
  matchConfidence: number | null;
  metadata: Record<string, string | undefined>;
  isDismissedOperational?: boolean;
  operationalReason?: string | null;
  review?: ReviewInfo | null;
  claim?: {
    claimedAt: string | null;
    claimedByUserId: string | null;
    claimedByName: string | null;
    clientId: string | null;
    clientName: string | null;
    source: "command_panel";
  } | null;
};

type UnmatchedFeed = {
  items: UnmatchedItem[];
  totalCount: number;
  needsReviewCount?: number;
  countsBySource?: { front: number; slack: number; zoom: number };
  clients: Array<{ id: string; firmName: string }>;
  // Task #4229: present only when the server's zoom/slack raw-records section
  // failed and the feed degraded to Front-only. Drives a non-blocking notice
  // so an empty Zoom/Slack section isn't mistaken for "everything is matched".
  degradedSources?: Array<"zoom" | "slack">;
};

const SOURCE_CONFIG = {
  front: { label: "Front Email", icon: Mail, color: "blue" },
  slack: { label: "Slack", icon: MessageSquare, color: "purple" },
  zoom: { label: "Zoom", icon: Video, color: "indigo" },
} as const;

const FEED_PAGE_SIZE = 100;

// Task #1624: extracted out of IntegrationsHub.tsx so the unmatched-feed
// triage UI can live at its own /admin/unmatched route under System Tools.
// The component owns every piece of state, every query / mutation, and
// every dialog the feed needs — backend endpoints are unchanged.
//
// The `?source=` filter + the legacy `integrationsHub.feedSourceFilter`
// localStorage key are preserved so deep-links and a reviewer's persisted
// last-used filter carry over from the pre-move Integrations Hub section.
export function UnmatchedFeedSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";

  const [assignDialog, setAssignDialog] = useState<UnmatchedItem | null>(null);
  const [contactOptInEmails, setContactOptInEmails] = useState<string[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [feedPage, setFeedPage] = useState(0);
  const [showDismissedOperational, setShowDismissedOperational] = useState(false);
  const [showRecentlyClaimed, setShowRecentlyClaimed] = useState(false);
  // Task #2104 — "By sender" grouped view: ranks unmatched senders by
  // count so the operator can knock out the biggest batches first and
  // turn each into a rule.
  const [showBySender, setShowBySender] = useState(false);

  // #695 / #1155 / #1156: feedSourceFilter is derived from the URL `?source=`
  // query param so deep-links open the right view, sharing the URL reproduces
  // the filter, and browser back/forward navigates between filter states.
  // Task #1155 also persists the reviewer's last-used filter to localStorage
  // so reviewers working through one source don't have to re-toggle the chip
  // every visit; on first load with no `?source=` we hydrate the URL from
  // that persisted value (replace, so back doesn't bounce).
  const [location, navigate] = useLocation();
  const search = useSearch();
  const feedSourceFilter: "all" | "front" | "slack" | "zoom" = (() => {
    const v = new URLSearchParams(search).get("source");
    return v === "front" || v === "slack" || v === "zoom" ? v : "all";
  })();
  const setFeedSourceFilter = useCallback(
    (next: "all" | "front" | "slack" | "zoom") => {
      const params = new URLSearchParams(search);
      if (next === "all") {
        params.delete("source");
      } else {
        params.set("source", next);
      }
      const qs = params.toString();
      navigate(qs ? `${location}?${qs}` : location, { replace: false });
    },
    [search, location, navigate],
  );

  // Task #1155: hydrate from localStorage on first mount when there's no
  // deep-link. Use replace: true so back doesn't bounce to the bare URL.
  // Task #1624: keep the legacy "integrationsHub.feedSourceFilter" key so a
  // reviewer's persisted last-used filter carries over from the pre-move UI.
  const didHydrateFilterRef = useRef(false);
  useEffect(() => {
    if (didHydrateFilterRef.current) return;
    didHydrateFilterRef.current = true;
    if (typeof window === "undefined") return;
    const current = new URLSearchParams(window.location.search).get("source");
    if (current === "front" || current === "slack" || current === "zoom") return;
    try {
      const stored = window.localStorage.getItem("integrationsHub.feedSourceFilter");
      if (stored === "front" || stored === "slack" || stored === "zoom") {
        const params = new URLSearchParams(window.location.search);
        params.set("source", stored);
        const qs = params.toString();
        navigate(qs ? `${window.location.pathname}?${qs}` : window.location.pathname, { replace: true });
      }
    } catch {
      // localStorage unavailable (private browsing, etc.) — ignore.
    }
  }, [navigate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (feedSourceFilter === "all") {
        window.localStorage.removeItem("integrationsHub.feedSourceFilter");
      } else {
        window.localStorage.setItem("integrationsHub.feedSourceFilter", feedSourceFilter);
      }
    } catch {
      // Ignore quota/availability errors — persistence is best-effort.
    }
  }, [feedSourceFilter]);

  const { data: feed, isLoading: feedLoading } = useQuery<UnmatchedFeed>({
    queryKey: [
      "/api/integrations/unmatched-feed",
      feedPage,
      showDismissedOperational,
      showRecentlyClaimed,
      feedSourceFilter,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(FEED_PAGE_SIZE),
        offset: String(feedPage * FEED_PAGE_SIZE),
      });
      if (showRecentlyClaimed) params.set("showRecentlyClaimed", "true");
      else if (showDismissedOperational) params.set("showDismissedOperational", "true");
      if (feedSourceFilter && feedSourceFilter !== "all") params.set("sourceType", feedSourceFilter);
      const res = await fetch(`/api/integrations/unmatched-feed?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch unmatched feed");
      return res.json();
    },
    enabled: isAdmin,
  });

  // Task #2104 — ranked unmatched-by-sender aggregation for the "By
  // sender" view. Only fetched while that view is open.
  const { data: bySenderData, isLoading: bySenderLoading } = useQuery<{
    senders: { senderEmail: string; count: number }[];
  }>({
    queryKey: ["/api/integrations/unmatched-by-sender"],
    queryFn: async () => {
      const res = await fetch("/api/integrations/unmatched-by-sender?limit=200", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch unmatched-by-sender");
      return res.json();
    },
    enabled: isAdmin && showBySender,
  });

  const assignMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({
      source,
      id,
      clientId,
      metadata,
      addContactEmails,
    }: {
      source: string;
      id: string;
      clientId: string;
      metadata?: Record<string, string | undefined>;
      addContactEmails?: string[];
    }) => {
      const body: Record<string, unknown> = { clientId };
      if (Array.isArray(addContactEmails) && addContactEmails.length > 0) {
        body.addContactEmails = addContactEmails;
      }
      if (source === "slack" && metadata) {
        body.channelName = metadata.channelName;
        body.senderName = metadata.senderName || metadata.userName;
        body.senderEmail = metadata.senderEmail || metadata.userEmail;
        body.messageText = metadata.messageText || metadata.text;
      }
      const res = await apiRequest("POST", `/api/integrations/unmatched/${source}/${id}/assign`, body);
      return res.json();
    },
    onSuccess: (data: any) => {
      logActivity("sync", "Assigned communication to client", { source: "integration" });
      const added = Number(data?.contactsAdded || 0);
      const created = Boolean(data?.contactCreated);
      const desc = added > 0
        ? created
          ? `Communication matched and a new contact was created with ${added} email${added === 1 ? "" : "s"}.`
          : `Communication matched and ${added} email${added === 1 ? "" : "s"} added to the client's contact.`
        : "Communication matched to client. No contact was created (default).";
      toast({ title: "Assigned", description: desc });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setAssignDialog(null);
      setSelectedClientId("");
      setContactOptInEmails([]);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ source, id }: { source: string; id: string }) => {
      const res = await apiRequest("POST", `/api/integrations/unmatched/${source}/${id}/dismiss`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Dismissed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const blockMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ source, id }: { source: string; id: string }) => {
      const res = await apiRequest("POST", `/api/integrations/unmatched/${source}/${id}/block`);
      return res.json();
    },
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/integrations/unmatched-feed"] });
      const feedQueries = queryClient.getQueriesData<UnmatchedFeed>({ queryKey: ["/api/integrations/unmatched-feed"] });
      for (const [queryKey, data] of feedQueries) {
        if (data) {
          const filteredItems = data.items.filter((item) => item.id !== id);
          const wasRemoved = filteredItems.length < data.items.length;
          queryClient.setQueryData<UnmatchedFeed>(queryKey, {
            ...data,
            items: filteredItems,
            totalCount: wasRemoved ? data.totalCount - 1 : data.totalCount,
          });
        }
      }
      return { feedQueries };
    },
    onSuccess: () => {
      toast({ title: "Blocked", description: "This item will never be matched again" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any, _vars, context) => {
      if (context?.feedQueries) {
        for (const [queryKey, data] of context.feedQueries) {
          if (data) queryClient.setQueryData(queryKey, data);
        }
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // #662: Undo a Command-Panel claim from the Recently Claimed view.
  const undoClaimMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ recordId, clientName: _clientName }: { recordId: string; clientName?: string }) => {
      const res = await apiRequest("POST", `/api/integrations/unmatched/undo-claim`, { recordId });
      return res.json() as Promise<{
        success: boolean;
        recordId: string;
        keyCallsDeleted?: number;
        rerRecordingsDeleted?: number;
        partialFailures?: string[];
      }>;
    },
    onSuccess: (data, variables) => {
      const keyCalls = Number(data?.keyCallsDeleted || 0);
      const rerRecordings = Number(data?.rerRecordingsDeleted || 0);
      const clientName = variables?.clientName?.trim();
      const removedParts: string[] = [];
      if (keyCalls > 0) removedParts.push(`${keyCalls} key call entr${keyCalls === 1 ? "y" : "ies"}`);
      if (rerRecordings > 0) removedParts.push(`${rerRecordings} RER recording${rerRecordings === 1 ? "" : "s"}`);
      const description = removedParts.length > 0
        ? `Removed ${removedParts.join(" and ")}${clientName ? ` from ${clientName}` : ""}.`
        : "Recording returned to unmatched feed.";
      toast({ title: "Claim undone", description });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Undo failed", description: err.message, variant: "destructive" }),
  });

  const [undoClaimConfirm, setUndoClaimConfirm] = useState<{ recordId: string; clientName?: string; recordingTitle?: string } | null>(null);

  // Task #1879: opens the rule-suggestion modal pre-populated with patterns
  // derived from a specific unmatched email row.
  const [suggestRulesTarget, setSuggestRulesTarget] = useState<
    { itemId: string; senderEmail: string | null; subject: string | null } | null
  >(null);

  const [reviewPendingDecisionId, setReviewPendingDecisionId] = useState<string | null>(null);

  const reviewApproveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ decisionId, clientId }: { decisionId: string; clientId?: string }) => {
      setReviewPendingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/approve`, {
        approvedClientId: clientId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Attribution applied", description: "Zoom call routed to client." });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setReviewPendingDecisionId(null);
    },
    onError: (err: any) => {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
      setReviewPendingDecisionId(null);
    },
  });

  const [reviewDismissTarget, setReviewDismissTarget] = useState<string | null>(null);
  const reviewDismissMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ decisionId, reason, reasonNote }: { decisionId: string; reason: DismissReason; reasonNote?: string }) => {
      setReviewPendingDecisionId(decisionId);
      const res = await apiRequest("POST", `/api/admin/zoom/review-queue/${decisionId}/dismiss`, { reason, reasonNote });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Left unattributed" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setReviewPendingDecisionId(null);
      setReviewDismissTarget(null);
    },
    onError: (err: any) => {
      toast({ title: "Dismiss failed", description: err.message, variant: "destructive" });
      setReviewPendingDecisionId(null);
    },
  });

  const promoteMutation = useMutation({
    meta: { silent: true },
    mutationFn: async ({ source, id }: { source: string; id: string }) => {
      const res = await apiRequest("POST", `/api/integrations/unmatched/${source}/${id}/promote`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Promoted", description: "Item moved back to unmatched for matching" });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const [bulkDismissDialog, setBulkDismissDialog] = useState<{ type: "domain" | "sender" | "channel"; value: string; count: number | null } | null>(null);

  const bulkDismissByDomainMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (domain: string) => {
      const res = await apiRequest("POST", "/api/integrations/bulk-dismiss-by-domain", { domain });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Domain Dismissed", description: `Dismissed ${data.dismissed} items from @${data.domain}` });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setBulkDismissDialog(null);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const bulkDismissByChannelMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (channelName: string) => {
      const res = await apiRequest("POST", "/api/integrations/bulk-dismiss-by-channel", { channelName });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Bulk Dismissed", description: `${data.dismissed || 0} items dismissed from #${data.channelName}` });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setBulkDismissDialog(null);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const bulkDismissBySenderMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (senderEmail: string) => {
      const res = await apiRequest("POST", "/api/integrations/bulk-dismiss-by-sender", { senderEmail });
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Sender Dismissed", description: `Dismissed ${data.dismissed} items from ${data.senderEmail}` });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"], refetchType: "all" }); // fire-and-forget: cache refresh only
      setBulkDismissDialog(null);
    },
    onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const handleBulkDismiss = async (type: "domain" | "sender" | "channel", value: string) => {
    try {
      const endpoint = type === "channel"
        ? `/api/integrations/count-by-channel?channelName=${encodeURIComponent(value)}`
        : type === "domain"
        ? `/api/integrations/count-by-domain?domain=${encodeURIComponent(value)}`
        : `/api/integrations/count-by-sender?senderEmail=${encodeURIComponent(value)}`;
      const res = await fetch(endpoint, { credentials: "include" });
      const data = await res.json();
      setBulkDismissDialog({ type, value, count: data.count ?? 0 });
    } catch {
      setBulkDismissDialog({ type, value, count: null });
    }
  };

  const formatDate = (ts: string | null) => {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };

  if (!isAdmin) return null;

  return (
    <>
      <Card className="bg-card" data-testid="card-unmatched-feed">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex flex-wrap items-center gap-2 min-w-0">
              <UserPlus className="w-5 h-5 text-amber-600" />
              {showRecentlyClaimed
                ? "Recently Claimed via Command Panel"
                : showDismissedOperational
                  ? "Dismissed as Operational"
                  : "Unmatched Communications"}
              {feed && (feed.totalCount || feed.items.length) > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    // #693: clicking the meeting/total count badge clears
                    // every active feed filter and returns to the default
                    // unmatched view.
                    setShowDismissedOperational(false);
                    setShowRecentlyClaimed(false);
                    setFeedSourceFilter("all");
                    setFeedPage(0);
                  }}
                  title={
                    feedSourceFilter !== "all" || showDismissedOperational || showRecentlyClaimed
                      ? "Clear all filters"
                      : "All filters cleared"
                  }
                  data-testid="button-clear-feed-filters"
                >
                  <Badge
                    className={`cursor-pointer hover:opacity-80 ${
                      showRecentlyClaimed
                        ? "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                        : showDismissedOperational
                          ? "bg-muted text-foreground border-border"
                          : "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800"
                    }`}
                    data-testid="badge-unmatched-count"
                  >
                    {feed.totalCount ?? feed.items.length}
                  </Badge>
                </button>
              )}
              {feed?.countsBySource && (feed.countsBySource.front + feed.countsBySource.slack + feed.countsBySource.zoom) > 0 && (
                <div className="flex items-center gap-1" data-testid="group-counts-by-source-hub">
                  {(["front", "slack", "zoom"] as const).map((src) => {
                    const Icon = src === "front" ? Mail : src === "slack" ? MessageSquare : Video;
                    const count = feed.countsBySource![src];
                    const active = feedSourceFilter === src;
                    const colorOn =
                      src === "front"
                        ? "bg-blue-600 text-white border-blue-600"
                        : src === "slack"
                          ? "bg-purple-600 text-white border-purple-600"
                          : "bg-indigo-600 text-white border-indigo-600";
                    const colorOff =
                      src === "front"
                        ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-950/50"
                        : src === "slack"
                          ? "bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800 dark:hover:bg-purple-950/50"
                          : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800 dark:hover:bg-indigo-950/50";
                    return (
                      <button
                        key={src}
                        type="button"
                        onClick={() => {
                          // #695: source chips toggle a feed-level source
                          // filter; clicking the active chip clears it.
                          setFeedSourceFilter(active ? "all" : src);
                          setFeedPage(0);
                        }}
                        aria-pressed={active}
                        title={active ? `Clear ${src} filter` : `Filter feed to ${src} only`}
                        data-testid={`button-source-filter-${src}`}
                      >
                        <Badge
                          className={`flex items-center gap-1 cursor-pointer ${active ? colorOn : colorOff}`}
                          data-testid={`badge-source-${src}`}
                        >
                          <Icon className="w-3 h-3" />
                          {count}
                        </Badge>
                      </button>
                    );
                  })}
                  {feedSourceFilter !== "all" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-xs text-muted-foreground"
                      onClick={() => {
                        setFeedSourceFilter("all");
                        setFeedPage(0);
                      }}
                      data-testid="button-clear-source-filter"
                    >
                      Clear
                    </Button>
                  )}
                </div>
              )}
              {!showDismissedOperational && !showRecentlyClaimed && feed && (feed.needsReviewCount ?? 0) > 0 && (
                <Badge
                  className="bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800 flex items-center gap-1"
                  data-testid="badge-needs-review-count"
                  title="Zoom items needing policy review"
                >
                  <AlertTriangle className="w-3 h-3" />
                  {feed.needsReviewCount} needs review
                </Badge>
              )}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              {feed?.countsBySource && feed.countsBySource.front > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  asChild
                  className="text-blue-700 border-blue-200 hover:bg-blue-50 hover:text-blue-800 dark:text-blue-300 dark:border-blue-800 dark:hover:bg-blue-950/40 dark:hover:text-blue-200"
                  title="Open the Front Console to run recovery jobs or inspect pipeline state"
                  data-testid="link-open-front-console-feed"
                >
                  <Link href="/admin/front">
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open in Front Console
                  </Link>
                </Button>
              )}
              <Button
                size="sm"
                variant={showDismissedOperational ? "default" : "outline"}
                className={showDismissedOperational ? "bg-gray-600 hover:bg-gray-700 text-white dark:bg-gray-500 dark:hover:bg-gray-400" : ""}
                onClick={() => {
                  setShowDismissedOperational(!showDismissedOperational);
                  if (!showDismissedOperational) setShowRecentlyClaimed(false);
                  setFeedPage(0);
                }}
                data-testid="button-toggle-operational"
              >
                <Filter className="w-3 h-3 mr-1" />
                {showDismissedOperational ? "Show Unmatched" : "Show Dismissed"}
              </Button>
              <Button
                size="sm"
                variant={showRecentlyClaimed ? "default" : "outline"}
                className={showRecentlyClaimed ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}
                onClick={() => {
                  setShowRecentlyClaimed(!showRecentlyClaimed);
                  if (!showRecentlyClaimed) setShowDismissedOperational(false);
                  setFeedPage(0);
                }}
                data-testid="button-toggle-recently-claimed"
                title="Show recordings claimed via the Command Panel"
              >
                <CheckCircle className="w-3 h-3 mr-1" />
                {showRecentlyClaimed ? "Show Unmatched" : "Show Recently Claimed"}
              </Button>
              <Button
                size="sm"
                variant={showBySender ? "default" : "outline"}
                className={showBySender ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
                onClick={() => {
                  setShowBySender((v) => !v);
                  if (!showBySender) {
                    setShowDismissedOperational(false);
                    setShowRecentlyClaimed(false);
                  }
                }}
                data-testid="button-toggle-by-sender"
                title="Group unmatched emails by sender, ranked by count"
              >
                <Users className="w-3 h-3 mr-1" />
                {showBySender ? "Show List" : "By Sender"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
                  void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-by-sender"], refetchType: "all" }); // fire-and-forget: cache refresh only
                }}
                data-testid="button-refresh-feed"
                aria-label="Refresh unmatched feed"
                title="Refresh unmatched feed"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Task #4229: non-blocking degraded-state notice. Without it, a
              zoom/slack DB failure renders an empty section that is
              indistinguishable from "everything is matched". */}
          {!showBySender && !showRecentlyClaimed && (feed?.degradedSources?.length ?? 0) > 0 && (
            <div
              className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950/30"
              data-testid="notice-feed-degraded"
            >
              <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  Zoom/Slack items are temporarily unavailable — the counts and list below only
                  reflect Front emails.
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/50"
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"], refetchType: "all" }); // fire-and-forget: cache refresh only
                }}
                data-testid="button-retry-degraded-feed"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Retry
              </Button>
            </div>
          )}
          {showBySender ? (
            bySenderLoading ? (
              <InlineLoadingSkeleton lines={4} />
            ) : !bySenderData?.senders?.length ? (
              <div className="text-center py-8 text-muted-foreground" data-testid="text-no-by-sender">
                <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-400 dark:text-green-500" />
                <p className="font-medium">No unmatched senders</p>
                <p className="text-sm">There are no unmatched emails to group by sender.</p>
              </div>
            ) : (
              <div className="divide-y border rounded-lg" data-testid="list-unmatched-by-sender">
                {bySenderData.senders.map((s) => (
                  <div
                    key={s.senderEmail}
                    className="flex items-center justify-between gap-2 p-2.5 hover:bg-muted/50"
                    data-testid={`row-by-sender-${s.senderEmail}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 shrink-0"
                        data-testid={`badge-sender-count-${s.senderEmail}`}
                      >
                        {s.count}
                      </Badge>
                      <span
                        className="font-mono text-sm truncate"
                        title={s.senderEmail}
                        data-testid={`text-sender-email-${s.senderEmail}`}
                      >
                        {s.senderEmail}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSuggestRulesTarget({
                            itemId: `by-sender-${s.senderEmail}`,
                            senderEmail: s.senderEmail,
                            subject: null,
                          })
                        }
                        data-testid={`button-create-rule-sender-${s.senderEmail}`}
                      >
                        <Sparkles className="w-3 h-3 mr-1" />
                        Create rule
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40"
                        onClick={() => handleBulkDismiss("sender", s.senderEmail)}
                        data-testid={`button-dismiss-all-sender-${s.senderEmail}`}
                      >
                        <Ban className="w-3 h-3 mr-1" />
                        Dismiss all
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : feedLoading ? (
            <InlineLoadingSkeleton lines={4} />
          ) : !feed?.items.length ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="text-no-unmatched">
              <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-400 dark:text-green-500" />
              <p className="font-medium">{showRecentlyClaimed ? "No recent Command Panel claims" : showDismissedOperational ? "No dismissed items" : "All caught up!"}</p>
              <p className="text-sm">{showRecentlyClaimed ? "No recordings have been claimed via the Command Panel in the last 30 days." : showDismissedOperational ? "No communications have been dismissed as operational noise." : "No unmatched communications waiting for review."}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {feedPage > 0 && (
                <p className="text-xs text-muted-foreground text-center">Showing {feedPage * FEED_PAGE_SIZE + 1}–{Math.min((feedPage + 1) * FEED_PAGE_SIZE, feed.totalCount ?? feed.items.length)} of {feed.totalCount ?? feed.items.length}</p>
              )}
              {feed.items.map((item) => {
                const config = SOURCE_CONFIG[item.source];
                const Icon = config.icon;
                const cardKey = `${item.source}-${item.id}`;
                const isExpanded = expandedCards.has(cardKey);
                const hasContent = !!(item.contentText || item.aiSummary);
                return (
                  <div key={cardKey} className="border rounded-lg p-3 hover:bg-muted/50 transition-colors" data-testid={`card-unmatched-${item.source}-${item.id}`}>
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 p-1.5 rounded-md bg-${config.color}-100`}>
                        <Icon className={`w-4 h-4 text-${config.color}-600`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className="text-xs px-1.5 py-0">{config.label}</Badge>
                          {item.timestamp && (
                            <span className="text-xs text-muted-foreground">{formatDate(item.timestamp)}</span>
                          )}
                        </div>
                        <p className="font-medium text-sm truncate">{item.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{item.snippet}</p>
                        {item.claim && (
                          <div
                            className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-emerald-800 dark:text-emerald-300"
                            data-testid={`claim-badge-${item.source}-${item.id}`}
                          >
                            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800 text-xs px-1.5 py-0">
                              <CheckCircle className="w-3 h-3 mr-0.5" />
                              Claimed via Command Panel
                            </Badge>
                            {item.claim.clientName && (
                              <span data-testid={`claim-client-${item.source}-${item.id}`}>
                                → <span className="font-medium">{item.claim.clientName}</span>
                              </span>
                            )}
                            {item.claim.claimedByName && (
                              <span className="text-emerald-700 dark:text-emerald-400" data-testid={`claim-by-${item.source}-${item.id}`}>
                                by {item.claim.claimedByName}
                              </span>
                            )}
                            {item.claim.claimedAt && (
                              <span className="text-emerald-600/70 dark:text-emerald-400/70">
                                · {formatDate(item.claim.claimedAt)}
                              </span>
                            )}
                            {item.metadata?.recordId && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:text-emerald-200 dark:hover:bg-emerald-950/40"
                                disabled={undoClaimMutation.isPending}
                                onClick={() => {
                                  const rid = item.metadata?.recordId;
                                  if (typeof rid === "string" && rid) {
                                    setUndoClaimConfirm({
                                      recordId: rid,
                                      clientName: item.claim?.clientName ?? undefined,
                                      recordingTitle: item.title,
                                    });
                                  }
                                }}
                                data-testid={`button-undo-claim-${item.source}-${item.id}`}
                              >
                                <RotateCcw className="w-3 h-3 mr-0.5" />
                                Undo
                              </Button>
                            )}
                          </div>
                        )}
                        {item.participants.length > 0 && (
                          <div className="mt-1">
                            <p className="text-xs text-muted-foreground truncate">{item.participants.slice(0, 3).join(", ")}{item.participants.length > 3 ? ` +${item.participants.length - 3}` : ""}</p>
                          </div>
                        )}
                        {!item.isDismissedOperational && (() => {
                          const senderParticipants = (item.participantsRaw || []).filter(p => !p.role || p.role === "external" || p.role === "team" || p.role === "from" || p.role === "sender");
                          const emails = senderParticipants.map(p => p.email).filter((e): e is string => !!e);
                          const domains = [...new Set(emails.map(e => e.split("@")[1]).filter((d): d is string => !!d))];
                          const channelName = item.source === "slack" && item.metadata?.channelName ? item.metadata.channelName : null;
                          if (emails.length === 0 && domains.length === 0 && !channelName) return null;
                          return (
                            <div className="flex flex-wrap gap-1 mt-0.5">
                              {channelName && (
                                <button
                                  key={`channel-${channelName}`}
                                  className="inline-flex items-center text-xs px-1.5 py-0 rounded bg-purple-50 text-purple-600 hover:bg-purple-100 border border-purple-100 dark:bg-purple-950/30 dark:text-purple-300 dark:hover:bg-purple-950/50 dark:border-purple-800 cursor-pointer"
                                  onClick={() => handleBulkDismiss("channel", channelName)}
                                  data-testid={`button-dismiss-channel-${channelName}`}
                                >
                                  <Ban className="w-2.5 h-2.5 mr-0.5" />
                                  Dismiss all from #{channelName}
                                </button>
                              )}
                              {domains.map(d => (
                                <button
                                  key={`domain-${d}`}
                                  className="inline-flex items-center text-xs px-1.5 py-0 rounded bg-red-50 text-red-600 hover:bg-red-100 border border-red-100 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50 dark:border-red-800 cursor-pointer"
                                  onClick={() => handleBulkDismiss("domain", d)}
                                  data-testid={`button-dismiss-domain-${d}`}
                                >
                                  <Ban className="w-2.5 h-2.5 mr-0.5" />
                                  Dismiss all @{d}
                                </button>
                              ))}
                              {emails.map(e => (
                                <button
                                  key={`sender-${e}`}
                                  className="inline-flex items-center text-xs px-1.5 py-0 rounded bg-orange-50 text-orange-600 hover:bg-orange-100 border border-orange-100 dark:bg-orange-950/30 dark:text-orange-300 dark:hover:bg-orange-950/50 dark:border-orange-800 cursor-pointer"
                                  onClick={() => handleBulkDismiss("sender", e)}
                                  data-testid={`button-dismiss-sender-${e}`}
                                >
                                  <Ban className="w-2.5 h-2.5 mr-0.5" />
                                  Dismiss all from {e}
                                </button>
                              ))}
                            </div>
                          );
                        })()}
                        {item.suggestedClientName && (
                          <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                            Suggested: {item.suggestedClientName}
                            {item.matchConfidence ? ` (${Math.round(item.matchConfidence * 100)}%)` : ""}
                          </p>
                        )}

                        {item.review && (() => {
                          const review = item.review;
                          const isReviewPending = reviewPendingDecisionId === review.decisionId;
                          return (
                            <div
                              className="mt-2 border border-yellow-300 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-950/30 rounded-md p-2 space-y-2"
                              data-testid={`review-panel-${item.source}-${item.id}`}
                            >
                              <div className="flex items-center gap-2">
                                <Badge
                                  variant="outline"
                                  className="bg-yellow-50 text-yellow-800 border-yellow-300 dark:bg-yellow-950/30 dark:text-yellow-300 dark:border-yellow-800"
                                  title={reviewReasonLabel(review.reviewReason)}
                                  data-testid={`badge-needs-review-${item.source}-${item.id}`}
                                >
                                  <AlertCircle className="w-3 h-3 mr-1" />
                                  Needs review
                                  <span className="ml-1 text-yellow-700 dark:text-yellow-400 text-xs">
                                    · {reviewReasonLabel(review.reviewReason)}
                                  </span>
                                </Badge>
                              </div>
                              {review.explanationSummary && (
                                <p className="text-xs text-yellow-900 dark:text-yellow-300" data-testid={`review-explanation-${item.source}-${item.id}`}>
                                  {review.explanationSummary}
                                </p>
                              )}
                              {review.suggestedClientName && (
                                <p className="text-xs text-yellow-900 dark:text-yellow-300" data-testid={`review-suggested-${item.source}-${item.id}`}>
                                  <span className="font-medium">Top suggestion:</span> {review.suggestedClientName}
                                  {review.suggestedConfidence != null && (
                                    <span className="ml-1 text-yellow-700 dark:text-yellow-400">({Math.round(review.suggestedConfidence * 100)}%)</span>
                                  )}
                                </p>
                              )}
                              {review.priorClientName && (
                                <p className="text-xs text-yellow-900 dark:text-yellow-300" data-testid={`review-prior-${item.source}-${item.id}`}>
                                  <span className="font-medium">Was attributed to:</span> {review.priorClientName}
                                </p>
                              )}
                              {(review.reopenedByName || review.reopenedByUserId || review.reopenedAt) && (
                                <p
                                  className="text-xs text-yellow-900 dark:text-yellow-300 flex items-center gap-1"
                                  data-testid={`review-reopened-${item.source}-${item.id}`}
                                >
                                  <RotateCcw className="w-3 h-3" />
                                  <span>
                                    <span className="font-medium">Re-opened</span>
                                    {(review.reopenedByName || review.reopenedByUserId) ? (
                                      <>
                                        {" by "}
                                        <span
                                          title={review.reopenedByEmail || undefined}
                                          data-testid={`text-review-reopened-by-${item.source}-${item.id}`}
                                        >
                                          {review.reopenedByName || review.reopenedByUserId}
                                        </span>
                                      </>
                                    ) : null}
                                    {review.reopenedAt ? ` · ${formatDate(review.reopenedAt)}` : ""}
                                    {(review.reopenCount ?? 0) > 1 ? ` (${review.reopenCount}×)` : ""}
                                  </span>
                                </p>
                              )}
                              {review.candidates.length > 0 && (
                                <div>
                                  <p className="text-xs uppercase font-medium text-yellow-700 dark:text-yellow-400 mb-1">Candidate shortlist</p>
                                  <ul className="space-y-1">
                                    {review.candidates.slice(0, 5).map((c, idx) => (
                                      <li
                                        key={`cand-${item.source}-${item.id}-${idx}`}
                                        className="flex items-center justify-between bg-card dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 rounded px-2 py-1 text-xs"
                                        data-testid={`review-candidate-${item.source}-${item.id}-${idx}`}
                                      >
                                        <span className="text-foreground">
                                          {c.clientName || c.clientId || "Unknown client"}
                                        </span>
                                        <div className="flex items-center gap-2">
                                          {c.confidenceScore != null && (
                                            <span className="text-muted-foreground">{Math.round(c.confidenceScore * 100)}%</span>
                                          )}
                                          {c.clientId && (
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="h-5 px-1.5 text-xs text-yellow-800 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-950/50"
                                              disabled={isReviewPending}
                                              onClick={() => reviewApproveMutation.mutate({ decisionId: review.decisionId, clientId: c.clientId! })}
                                              data-testid={`button-review-route-${item.source}-${item.id}-${idx}`}
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
                              <div className="flex flex-wrap items-center gap-2">
                                {review.suggestedClientId && (
                                  <Button
                                    size="sm"
                                    className="h-7 text-xs bg-yellow-600 hover:bg-yellow-700 text-white dark:bg-yellow-700 dark:hover:bg-yellow-600"
                                    disabled={isReviewPending}
                                    onClick={() => reviewApproveMutation.mutate({ decisionId: review.decisionId })}
                                    data-testid={`button-review-accept-${item.source}-${item.id}`}
                                  >
                                    {isReviewPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                                    Accept suggestion
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs text-yellow-800 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-950/50"
                                  disabled={isReviewPending}
                                  onClick={() => setReviewDismissTarget(review.decisionId)}
                                  data-testid={`button-review-dismiss-${item.source}-${item.id}`}
                                >
                                  Leave unattributed
                                </Button>
                              </div>
                            </div>
                          );
                        })()}

                        {item.isDismissedOperational && item.operationalReason && (
                          <div className="mt-1.5 p-1.5 bg-muted border border-border rounded text-xs" data-testid={`reason-operational-${item.source}-${item.id}`}>
                            <span className="text-muted-foreground font-medium">Dismissed: </span>
                            <span className="text-foreground">{item.operationalReason}</span>
                          </div>
                        )}

                        {item.aiSummary && (
                          <div className="mt-2 p-2 bg-purple-50 border border-purple-100 dark:bg-purple-950/30 dark:border-purple-800 rounded text-xs" data-testid={`summary-${item.source}-${item.id}`}>
                            <div className="flex items-center gap-1 text-purple-700 dark:text-purple-300 font-medium mb-0.5">
                              <Sparkles className="w-3 h-3" /> AI Summary
                            </div>
                            <p className="text-purple-900 dark:text-purple-300 whitespace-pre-wrap">{item.aiSummary}</p>
                          </div>
                        )}

                        {hasContent && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-xs text-muted-foreground mt-1 px-1"
                            onClick={() => {
                              setExpandedCards(prev => {
                                const next = new Set(prev);
                                if (next.has(cardKey)) next.delete(cardKey);
                                else next.add(cardKey);
                                return next;
                              });
                            }}
                            data-testid={`button-expand-${item.source}-${item.id}`}
                          >
                            <FileText className="w-3 h-3 mr-1" />
                            {isExpanded ? "Hide" : "Show"} Full Content
                            {isExpanded ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
                          </Button>
                        )}

                        {isExpanded && item.contentText && (
                          <div className="mt-2 p-2 bg-muted border border-border rounded max-h-64 overflow-y-auto" data-testid={`transcript-${item.source}-${item.id}`}>
                            <p className="text-xs text-muted-foreground font-medium mb-1">Full Content</p>
                            <pre className="text-xs text-foreground whitespace-pre-wrap font-sans">{item.contentText}</pre>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        {item.isDismissedOperational ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => promoteMutation.mutate({ source: item.source, id: item.id })}
                            disabled={promoteMutation.isPending}
                            data-testid={`button-promote-${item.source}-${item.id}`}
                          >
                            <RotateCcw className="w-3 h-3 mr-1" /> Promote
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => {
                                setAssignDialog(item);
                                setSelectedClientId(item.suggestedClientId || "");
                              }}
                              data-testid={`button-assign-${item.source}-${item.id}`}
                            >
                              <UserPlus className="w-3 h-3 mr-1" /> Match
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-muted-foreground"
                              onClick={() => dismissMutation.mutate({ source: item.source, id: item.id })}
                              data-testid={`button-dismiss-${item.source}-${item.id}`}
                            >
                              Dismiss
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-red-500 dark:text-red-400"
                              onClick={() => blockMutation.mutate({ source: item.source, id: item.id })}
                              data-testid={`button-block-${item.source}-${item.id}`}
                            >
                              <Ban className="w-3 h-3 mr-1" /> Block
                            </Button>
                            {item.source === "front" && (() => {
                              const senderPart = (item.participantsRaw || []).find(
                                (p) =>
                                  !!p.email &&
                                  (!p.role || p.role === "external" || p.role === "team" || p.role === "from" || p.role === "sender"),
                              );
                              const senderEmail = senderPart?.email ?? null;
                              const subject = item.title ?? null;
                              if (!senderEmail && !(subject && subject.trim().length >= 4)) return null;
                              return (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs text-blue-600 dark:text-blue-400"
                                  onClick={() =>
                                    setSuggestRulesTarget({
                                      itemId: item.id,
                                      senderEmail,
                                      subject,
                                    })
                                  }
                                  data-testid={`button-suggest-filter-${item.source}-${item.id}`}
                                >
                                  <Filter className="w-3 h-3 mr-1" /> Filter messages like these
                                </Button>
                              );
                            })()}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {feed && (feed.totalCount ?? 0) > FEED_PAGE_SIZE && (
                <div className="flex items-center justify-between pt-3 border-t">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={feedPage === 0}
                    onClick={() => setFeedPage(p => Math.max(0, p - 1))}
                    data-testid="button-feed-prev"
                  >
                    Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {feedPage + 1} of {Math.ceil((feed.totalCount ?? feed.items.length) / FEED_PAGE_SIZE)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={(feedPage + 1) * FEED_PAGE_SIZE >= (feed.totalCount ?? 0)}
                    onClick={() => setFeedPage(p => p + 1)}
                    data-testid="button-feed-next"
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!assignDialog} onOpenChange={() => { setAssignDialog(null); setSelectedClientId(""); setContactOptInEmails([]); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Match to Client</DialogTitle>
            <DialogDescription>
              {assignDialog?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Select Client</Label>
              <Select value={selectedClientId} onValueChange={setSelectedClientId}>
                <SelectTrigger data-testid="select-assign-client" aria-label="Select client to match">
                  <SelectValue placeholder="Choose a client..." />
                </SelectTrigger>
                <SelectContent className="max-h-[300px] overflow-y-auto">
                  {feed?.clients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.firmName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(() => {
              const candidates = [...new Map(
                (assignDialog?.participantsRaw || [])
                  .filter(p => p.email && p.email.includes("@") && (p.role || "external") !== "team")
                  .map(p => [p.email!.toLowerCase(), { email: p.email!.toLowerCase(), name: p.name }]),
              ).values()];
              if (candidates.length === 0) return null;
              return (
                <div className="space-y-2 border-t pt-3">
                  <Label className="text-sm">Add as client contact?</Label>
                  <p className="text-xs text-muted-foreground">
                    Default is no. Only emails you check will be saved as a contact for this client.
                  </p>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto" data-testid="list-contact-opt-in">
                    {candidates.map((p) => {
                      const checked = contactOptInEmails.includes(p.email);
                      return (
                        <label key={p.email} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setContactOptInEmails((prev) =>
                                e.target.checked
                                  ? [...prev, p.email]
                                  : prev.filter((x) => x !== p.email),
                              );
                            }}
                            data-testid={`checkbox-add-contact-${p.email}`}
                          />
                          <span className="font-mono text-xs">{p.email}</span>
                          {p.name ? <span className="text-muted-foreground text-xs">— {p.name}</span> : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAssignDialog(null); setSelectedClientId(""); setContactOptInEmails([]); }}>Cancel</Button>
            <Button
              onClick={() => assignDialog && assignMutation.mutate({
                source: assignDialog.source,
                id: assignDialog.id,
                clientId: selectedClientId,
                metadata: assignDialog.metadata,
                addContactEmails: contactOptInEmails,
              })}
              disabled={!selectedClientId || assignMutation.isPending}
              data-testid="button-confirm-assign"
            >
              {assignMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <ArrowRight className="w-4 h-4 mr-1" />}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!bulkDismissDialog} onOpenChange={() => setBulkDismissDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {bulkDismissDialog?.type === "channel" ? `Dismiss all from #${bulkDismissDialog.value}` : bulkDismissDialog?.type === "domain" ? `Dismiss all from @${bulkDismissDialog.value}` : `Dismiss all from ${bulkDismissDialog?.value}`}
            </DialogTitle>
            <DialogDescription>
              {bulkDismissDialog?.count !== null && bulkDismissDialog?.count !== undefined
                ? `This will dismiss ${bulkDismissDialog.count} unmatched item${bulkDismissDialog.count !== 1 ? "s" : ""} and auto-learn this pattern for future filtering.`
                : "This will dismiss all matching unmatched items and auto-learn this pattern for future filtering."
              }
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            {bulkDismissDialog?.type === "channel"
              ? `All unmatched Slack messages from #${bulkDismissDialog.value} will be marked as operational noise.`
              : bulkDismissDialog?.type === "domain"
              ? `All unmatched communications from any sender @${bulkDismissDialog.value} will be marked as operational noise.`
              : `All unmatched communications from ${bulkDismissDialog?.value} will be marked as operational noise.`
            }
            <p className="mt-2 text-xs text-muted-foreground">Dismissed items can be restored later from the "Show Dismissed" view using the Promote button.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDismissDialog(null)} data-testid="button-cancel-bulk-dismiss">Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!bulkDismissDialog) return;
                if (bulkDismissDialog.type === "channel") {
                  bulkDismissByChannelMutation.mutate(bulkDismissDialog.value);
                } else if (bulkDismissDialog.type === "domain") {
                  bulkDismissByDomainMutation.mutate(bulkDismissDialog.value);
                } else {
                  bulkDismissBySenderMutation.mutate(bulkDismissDialog.value);
                }
              }}
              disabled={bulkDismissByDomainMutation.isPending || bulkDismissBySenderMutation.isPending || bulkDismissByChannelMutation.isPending}
              data-testid="button-confirm-bulk-dismiss"
            >
              {(bulkDismissByDomainMutation.isPending || bulkDismissBySenderMutation.isPending || bulkDismissByChannelMutation.isPending) ? (
                <Loader2 className="w-4 h-4 animate-spin mr-1" />
              ) : (
                <Ban className="w-4 h-4 mr-1" />
              )}
              Dismiss {bulkDismissDialog?.count !== null && bulkDismissDialog?.count !== undefined ? `${bulkDismissDialog.count} items` : "all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SuggestRulesDialog
        open={suggestRulesTarget !== null}
        onClose={() => setSuggestRulesTarget(null)}
        senderEmail={suggestRulesTarget?.senderEmail ?? null}
        subject={suggestRulesTarget?.subject ?? null}
        itemId={suggestRulesTarget?.itemId}
      />

      <DismissReasonDialog
        open={reviewDismissTarget !== null}
        onOpenChange={(open) => !open && setReviewDismissTarget(null)}
        isPending={reviewDismissMutation.isPending}
        onConfirm={(reason, note) => {
          if (reviewDismissTarget) {
            reviewDismissMutation.mutate({ decisionId: reviewDismissTarget, reason, reasonNote: note });
          }
        }}
      />

      <AlertDialog
        open={undoClaimConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setUndoClaimConfirm(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-confirm-undo-claim">
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this claim?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <div>
                  {undoClaimConfirm?.clientName ? (
                    <>
                      This will un-attribute{" "}
                      <span
                        className="font-medium"
                        data-testid="text-undo-claim-recording-title"
                      >
                        {undoClaimConfirm.recordingTitle || "this recording"}
                      </span>{" "}
                      from{" "}
                      <span
                        className="font-medium"
                        data-testid="text-undo-claim-client-name"
                      >
                        {undoClaimConfirm.clientName}
                      </span>
                      .
                    </>
                  ) : (
                    <>
                      This will un-attribute{" "}
                      <span
                        className="font-medium"
                        data-testid="text-undo-claim-recording-title"
                      >
                        {undoClaimConfirm?.recordingTitle || "this recording"}
                      </span>
                      .
                    </>
                  )}
                </div>
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                  <li>The recording returns to the unmatched feed.</li>
                  <li>The corresponding key-call / RER row will be removed.</li>
                  <li>The agent memory will be penalized for this match.</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-undo-claim" disabled={undoClaimMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-undo-claim"
              disabled={undoClaimMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (undoClaimConfirm) {
                  const rid = undoClaimConfirm.recordId;
                  const cname = undoClaimConfirm.clientName;
                  undoClaimMutation.mutate(
                    { recordId: rid, clientName: cname },
                    { onSettled: () => setUndoClaimConfirm(null) },
                  );
                }
              }}
            >
              {undoClaimMutation.isPending ? "Undoing…" : "Undo claim"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
