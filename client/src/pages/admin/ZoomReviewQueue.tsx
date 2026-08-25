import { useEffect, useMemo, useRef, useState } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { ResetSavedViewButton } from "@/components/ResetSavedViewButton";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Loader2, CheckCircle2, XCircle, RefreshCw, Bell, BellOff, Send, RotateCcw, Check, ChevronsUpDown, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/admin/PageHeader";
import { StatusPill } from "@/components/kit/StatusPill";
import { DismissReasonDialog } from "@/components/DismissReasonDialog";
import { ReopenConfirmDialog } from "@/components/ReopenConfirmDialog";
import { type DismissReason, dismissReasons, dismissReasonLabels } from "@shared/schema";

// Audit P2-12: queue rows rest neutral — amber is reserved for rows that have
// waited past the operator-tuned backed-up-queue age threshold (the same
// `ageHoursThreshold` the alert settings card manages), so an amber pill always
// means "aging", never merely "exists". Red stays reserved for genuinely
// blocking states, of which this queue currently has none.
const DEFAULT_AGING_THRESHOLD_HOURS = 24; // mirrors the alert-settings server default

function pendingAgeHours(createdAt: string): number | null {
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function formatAgeShort(hours: number): string {
  if (hours >= 48) return `${Math.floor(hours / 24)}d`;
  return `${Math.max(1, Math.round(hours))}h`;
}

type Decision = {
  id: string;
  communicationId: string;
  communicationType: string;
  sourceType: string | null;
  clientId: string;
  confidenceScore: number;
  status: string;
  reviewReason: string | null;
  reviewResolution: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  reopenedAt: string | null;
  reopenedByUserId: string | null;
  reopenCount: number | null;
  priorClientId: string | null;
  candidateShortlistJson: any;
  supportingSignalsJson: any;
  explanationSummary: string | null;
  semanticReasoningSummary: string | null;
  createdAt: string;
};

const COMPARATIVE_NONE_PREFIX = "[comparative-eval:none]";
const COMPARATIVE_NOT_CHOSEN_PREFIX = "[comparative-eval:not-chosen]";

function formatEmailSkipReason(reason: string): string {
  switch (reason) {
    case "no_recipients":
      return "no recipients configured";
    case "missing_api_key":
      return "email sending isn't set up — an admin needs to connect SendGrid";
    case "missing_sender":
      return "no sender address chosen";
    case "missing_api_key_and_sender":
      return "email sending isn't set up — an admin needs to connect SendGrid and choose a sender";
    case "timeout":
      return "timed out";
    case "send_error":
      return "send error";
    case "not_applicable_for_cleared":
      return "not sent on all-clear";
    default:
      if (reason.startsWith("send_failed_")) {
        return `send failed (HTTP ${reason.slice("send_failed_".length)})`;
      }
      return reason;
  }
}

function formatSlackPostError(detail: string): string {
  const d = detail.trim();
  switch (d) {
    case "channel_not_found":
      return "channel not found";
    case "not_in_channel":
      return "bot not in channel";
    case "is_archived":
      return "channel is archived";
    case "invalid_auth":
    case "token_revoked":
    case "token_expired":
      return "invalid auth";
    case "account_inactive":
      return "Slack account inactive";
    case "missing_scope":
      return "missing Slack scope";
    case "rate_limited":
      return "rate limited";
    case "msg_too_long":
      return "message too long";
    case "no_text":
      return "no text";
    default:
      return d || "unknown";
  }
}

function formatSlackSkipReason(reason: string): string {
  if (reason === "not_connected") return "Slack not connected";
  if (reason === "missing_channel") return "no channel configured";
  if (reason.startsWith("post_failed:")) {
    return `post failed (${formatSlackPostError(reason.slice("post_failed:".length))})`;
  }
  if (reason.startsWith("not_connected_check_failed:")) {
    return `connection check failed (${reason.slice("not_connected_check_failed:".length)})`;
  }
  if (reason.startsWith("load_failed:")) {
    return `Slack module unavailable (${reason.slice("load_failed:".length)})`;
  }
  return reason;
}

function stripComparativePrefix(text: string): string {
  return text
    .replace(COMPARATIVE_NONE_PREFIX, "")
    .replace(COMPARATIVE_NOT_CHOSEN_PREFIX, "")
    .trim();
}

type RawRecord = {
  id: string;
  title: string | null;
  timestamp: string;
  contentPreview: string | null;
  participantsJson: any;
  externalUrl: string | null;
  sourceType: string;
  rawPayloadJson?: any;
};

type QueueItem = {
  decision: Decision;
  rawRecord: RawRecord | null;
  suggestedClientName: string | null;
  priorClientName: string | null;
  reopenedByUserName: string | null;
  reopenedByUserEmail: string | null;
};

type SignalRow = { type: string; value: string; weight: number };

type ReasonSummary = {
  windowDays: number | null;
  total: number;
  byReason: Record<string, number>;
};

type Thresholds = {
  strongSignalMinWeight: number;
  shortTokenMaxLen: number;
};

type SourceCounts = {
  backfill: number;
  live: number;
  total: number;
};

type DismissSummary = {
  windowDays: number | null;
  total: number;
  byReason: Record<string, number>;
  recentOtherNotes: { note: string; reviewedAt: string | null }[];
};

type PreviousDismissSummary = {
  byReason: Record<string, number>;
  total: number;
};

type ResolutionBuckets = {
  approved: number;
  reassigned: number;
  dismissed: number;
  reopened: number;
  unresolved: number;
};

type ResolutionSummary = {
  windowDays: number | null;
  total: number;
  byResolution: ResolutionBuckets;
};

type PreviousResolutionSummary = {
  byResolution: ResolutionBuckets;
  total: number;
};

type ReviewQueueResponse = {
  items: QueueItem[];
  reasonSummary: ReasonSummary;
  dismissSummary?: DismissSummary;
  previousDismissSummary?: PreviousDismissSummary | null;
  resolutionSummary?: ResolutionSummary;
  previousResolutionSummary?: PreviousResolutionSummary | null;
  sourceCounts?: SourceCounts;
  source?: "all" | "backfill" | "live";
  thresholds: Thresholds;
  windowDays: number | null;
};

const BACKFILL_EXPLANATION_PREFIX = "[backfill]";

function isBackfillItem(item: QueueItem): boolean {
  const s = item.decision.explanationSummary || "";
  return s.startsWith(BACKFILL_EXPLANATION_PREFIX);
}

function stripBackfillPrefix(text: string): string {
  if (text.startsWith(BACKFILL_EXPLANATION_PREFIX)) {
    return text.slice(BACKFILL_EXPLANATION_PREFIX.length).trim();
  }
  return text;
}

const REASON_LABELS: Record<string, string> = {
  weak_signal_only: "Weak signal only",
  contact_name_only_weak: "Contact name only (weak)",
  solo_internal_participants: "Solo internal participants",
  unspecified: "Unspecified",
  // Task #4050 — deterministic Zoom tier demotions (no tunable thresholds;
  // these render in the "other reasons" list of the breakdown card).
  ambiguous_trusted_domain: "Multiple clients share this email domain",
  ambiguous_topic_firm: "Topic matches multiple firm names",
  person_name_topic: "Topic looks like a person's name",
  conflicting_signals: "Domain and topic signals disagree",
};

function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "—";
  return REASON_LABELS[reason] || reason;
}

function thresholdHintForReason(reason: string | null | undefined, t: Thresholds): string | null {
  if (!reason) return null;
  switch (reason) {
    case "weak_signal_only":
      return `Needs strong-signal weight ≥ ${t.strongSignalMinWeight}.`;
    case "contact_name_only_weak":
      return `Tokens ≤ ${t.shortTokenMaxLen} chars or on the common-first-name list count as weak.`;
    case "solo_internal_participants":
      return "Every meeting participant resolved to an internal user/domain.";
    default:
      return null;
  }
}

const WINDOW_OPTIONS: { label: string; value: string }[] = [
  { label: "Last 24 hours", value: "1" },
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "All time", value: "all" },
];

type ClientOption = { id: string; firmName: string };

function ClientPicker({
  clients,
  isLoading,
  isError,
  onRetry,
  value,
  onChange,
  placeholder,
  testId,
}: {
  clients: ClientOption[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? clients.find((c) => c.id === value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-64 justify-between font-normal"
          data-testid={testId}
        >
          <span className="truncate text-left">
            {selected
              ? selected.firmName
              : isLoading
                ? "Loading clients…"
                : isError
                  ? "Couldn't load clients"
                  : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        {isError ? (
          <div className="p-3 text-sm space-y-2" data-testid={`${testId}-error`}>
            <div className="text-destructive">Couldn't load the client list.</div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRetry()}
              data-testid={`${testId}-retry`}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Retry
            </Button>
          </div>
        ) : (
        <Command>
          <CommandInput placeholder="Search clients…" />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading clients…" : "No client found."}
            </CommandEmpty>
            <CommandGroup>
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.firmName}
                  onSelect={() => {
                    onChange(c.id);
                    setOpen(false);
                  }}
                  data-testid={`${testId}-option-${c.id}`}
                >
                  <Check
                    className={`mr-2 h-4 w-4 ${value === c.id ? "opacity-100" : "opacity-0"}`}
                  />
                  {c.firmName}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

const ALERT_HISTORY_PAGE_SIZE = 10;

export default function ZoomReviewQueue() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const ns = user?.id ? `admin.zoomReviewQueue.${user.id}` : null;
  const validWindow = (v: unknown): v is string =>
    typeof v === "string" && WINDOW_OPTIONS.some((o) => o.value === v);
  const validSource = (v: unknown): v is "all" | "backfill" | "live" =>
    v === "all" || v === "backfill" || v === "live";
  const isString = (v: unknown): v is string => typeof v === "string";
  const isBool = (v: unknown): v is boolean => typeof v === "boolean";
  const [includeResolved, setIncludeResolved] = usePersistentState<boolean>(
    ns ? `${ns}.includeResolved` : null,
    false,
    isBool,
  );
  const [reassignFor, setReassignFor] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [reasonFilter, setReasonFilter] = usePersistentState<string>(
    ns ? `${ns}.reasonFilter` : null,
    "all",
    isString,
  );
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [windowSel, setWindowSel] = usePersistentState<string>(
    ns ? `${ns}.windowSel` : null,
    "7",
    validWindow,
  );
  const [sourceFilter, setSourceFilter] = usePersistentState<"all" | "backfill" | "live">(
    ns ? `${ns}.sourceFilter` : null,
    "all",
    validSource,
  );
  const validDismissReason = (v: unknown): v is string =>
    typeof v === "string" &&
    (v === "all" ||
      v === "unspecified" ||
      (dismissReasons as readonly string[]).includes(v));
  const [dismissReasonFilter, setDismissReasonFilter] = usePersistentState<string>(
    ns ? `${ns}.dismissReasonFilter` : null,
    "all",
    validDismissReason,
  );
  // #734: shared resolution-type filter primitive. Replaces ad-hoc badge
  // toggles for "approved", "reassigned", "reopened" so all three resolution
  // outcomes use the same filter chip group instead of one-off code paths.
  type ResolutionFilter = "all" | "unresolved" | "approved" | "reassigned" | "dismissed" | "reopened";
  const validResolutionFilter = (v: unknown): v is ResolutionFilter =>
    v === "all" || v === "unresolved" || v === "approved" || v === "reassigned" || v === "dismissed" || v === "reopened";
  const [resolutionFilter, setResolutionFilter] = usePersistentState<ResolutionFilter>(
    ns ? `${ns}.resolutionFilter` : null,
    "all",
    validResolutionFilter,
  );

  const persistedViewKeys = useMemo(
    () =>
      ns
        ? [
            `${ns}.includeResolved`,
            `${ns}.reasonFilter`,
            `${ns}.windowSel`,
            `${ns}.sourceFilter`,
            `${ns}.dismissReasonFilter`,
            `${ns}.resolutionFilter`,
          ]
        : [],
    [ns],
  );
  const handleResetSavedView = () => {
    setIncludeResolved(false);
    setReasonFilter("all");
    setWindowSel("7");
    setSourceFilter("all");
    setDismissReasonFilter("all");
    setResolutionFilter("all");
  };

  const clientsQuery = useQuery<ClientOption[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch clients: ${res.status}`);
      return res.json();
    },
  });
  const clientOptions = useMemo<ClientOption[]>(() => {
    const list = (clientsQuery.data ?? [])
      .map((c) => ({ id: c.id, firmName: c.firmName }))
      .filter((c) => !!c.id && !!c.firmName);
    list.sort((a, b) => a.firmName.localeCompare(b.firmName));
    return list;
  }, [clientsQuery.data]);
  const clientNameById = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const c of clientsQuery.data ?? []) {
      if (c.id && c.firmName) map[c.id] = c.firmName;
    }
    return map;
  }, [clientsQuery.data]);
  const resolveFirmName = (
    clientId: string | null | undefined,
    preferredName?: string | null,
  ): string => {
    if (preferredName) return preferredName;
    if (clientId && clientNameById[clientId]) return clientNameById[clientId];
    if (clientId) return "Unknown firm";
    return "—";
  };

  // #734: pushing the resolution filter to the server lets a chip like
  // "Approved" return the right rows even when the includeResolved switch is
  // off — matching how dismissReason works.
  const { data, isLoading, refetch } = useQuery<ReviewQueueResponse>({
    queryKey: [
      "/api/admin/zoom/review-queue",
      { includeResolved, windowSel, sourceFilter, dismissReasonFilter, resolutionFilter },
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ includeResolved: String(includeResolved) });
      if (windowSel !== "all") params.set("windowDays", windowSel);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (dismissReasonFilter !== "all") params.set("dismissReason", dismissReasonFilter);
      if (
        resolutionFilter === "approved" ||
        resolutionFilter === "reassigned" ||
        resolutionFilter === "dismissed" ||
        resolutionFilter === "reopened"
      ) {
        params.set("reviewResolution", resolutionFilter);
      }
      const res = await fetch(`/api/admin/zoom/review-queue?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
  });

  // Task #996: at-a-glance backlog trend (now / 24h ago / 7d ago, plus the
  // inflow / outflow over each window) so operators can tell whether the
  // post-Task-#993 unmatched-Zoom backlog is growing or shrinking.
  type ReviewQueueTrend = {
    pendingCount: number;
    pendingCount24hAgo: number;
    pendingCount7dAgo: number;
    createdLast24h: number;
    createdLast7d: number;
    resolvedLast24h: number;
    resolvedLast7d: number;
  };
  const trendQuery = useQuery<ReviewQueueTrend>({
    queryKey: ["/api/admin/zoom/review-queue/trend"],
    queryFn: async () => {
      const res = await fetch("/api/admin/zoom/review-queue/trend", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  // Task #996: bulk-action selection. Tracks decision IDs the operator has
  // checked across renders; we prune IDs that fall out of the current filter
  // result set so stale checks don't leak between filter changes.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDismissOpen, setBulkDismissOpen] = useState(false);
  const [bulkAssignClientId, setBulkAssignClientId] = useState<string>("");

  const approve = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { id: string; approvedClientId?: string }) => {
      return apiRequest("POST", `/api/admin/zoom/review-queue/${vars.id}/approve`, {
        approvedClientId: vars.approvedClientId,
      });
    },
    onSuccess: () => {
      toast({ title: "Approved", description: "Zoom call attribution applied." });
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
    },
    onError: (e: any) => toast({ title: "Approve failed", description: e.message, variant: "destructive" }),
  });

  const [dismissTargetId, setDismissTargetId] = useState<string | null>(null);
  const [reopenTargetId, setReopenTargetId] = useState<string | null>(null);
  const dismiss = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { id: string; reason: DismissReason; reasonNote?: string }) => {
      return apiRequest("POST", `/api/admin/zoom/review-queue/${vars.id}/dismiss`, {
        reason: vars.reason,
        reasonNote: vars.reasonNote,
      });
    },
    onSuccess: () => {
      toast({ title: "Dismissed", description: "Zoom call left unattributed." });
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setDismissTargetId(null);
    },
    onError: (e: any) => toast({ title: "Dismiss failed", description: e.message, variant: "destructive" }),
  });

  const reopen = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { id: string }) => {
      return apiRequest("POST", `/api/admin/zoom/review-queue/${vars.id}/reopen`, {});
    },
    onSuccess: () => {
      toast({ title: "Re-opened", description: "Zoom call is back in the review queue." });
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      setReopenTargetId(null);
    },
    onError: (e: any) => toast({ title: "Re-open failed", description: e.message, variant: "destructive" }),
  });

  // Task #996: bulk-action mutations. Both surface succeeded/failed counts so
  // the operator sees partial success when individual rows fail validation
  // (e.g. no-candidate row missing approvedClientId, "other" dismiss without
  // a note). The success path also clears the selection and refreshes both
  // the queue list and the trend snapshot.
  const bulkDismiss = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { decisionIds: string[]; reason: DismissReason; reasonNote?: string }) => {
      return apiRequest("POST", "/api/admin/zoom/review-queue/bulk-dismiss", vars);
    },
    onSuccess: (result: any) => {
      const ok = result?.succeeded?.length ?? 0;
      const fail = result?.failed?.length ?? 0;
      toast({
        title: fail === 0 ? "Bulk dismiss complete" : "Bulk dismiss partial",
        description: `${ok} dismissed${fail > 0 ? ` · ${fail} failed` : ""}`,
        variant: fail > 0 ? "destructive" : undefined,
      });
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue/trend"] }); // fire-and-forget: cache refresh only
      setSelectedIds(new Set());
      setBulkDismissOpen(false);
    },
    onError: (e: any) => toast({ title: "Bulk dismiss failed", description: e.message, variant: "destructive" }),
  });

  const bulkApprove = useMutation({
    meta: { silent: true },
    mutationFn: async (vars: { decisionIds: string[]; approvedClientId?: string }) => {
      return apiRequest("POST", "/api/admin/zoom/review-queue/bulk-approve", vars);
    },
    onSuccess: (result: any) => {
      const ok = result?.succeeded?.length ?? 0;
      const fail = result?.failed?.length ?? 0;
      toast({
        title: fail === 0 ? "Bulk assign complete" : "Bulk assign partial",
        description: `${ok} assigned${fail > 0 ? ` · ${fail} failed` : ""}`,
        variant: fail > 0 ? "destructive" : undefined,
      });
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue"] }); // fire-and-forget: cache refresh only
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue/trend"] }); // fire-and-forget: cache refresh only
      setSelectedIds(new Set());
      setBulkAssignClientId("");
    },
    onError: (e: any) => toast({ title: "Bulk assign failed", description: e.message, variant: "destructive" }),
  });

  const allItems = useMemo(() => data?.items || [], [data?.items]);

  // Task #1106: deep-link from the unmatched-Zoom picker. When the URL has
  // `?focus=<decisionId>`, scroll the matching card into view and apply a
  // brief highlight ring so operators can see exactly which row the picker
  // sent them to. We only run this once per (focus + data) pair: the effect
  // re-fires when `data` arrives so the card has actually rendered, and the
  // ref guards against re-highlighting on every refetch.
  const focusId = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const v = params.get("focus");
    return v && v.trim() ? v.trim() : null;
  }, []);

  // Task #1157: deep-link from a guardrail-impact sparkline bar in the match
  // settings page. Bars send `?reviewReason=<reason>&from=<iso>&to=<iso>`,
  // which we read once on mount: the reason seeds the existing reason filter
  // and the [from, to) range becomes a precise ms-level overlay on top of the
  // existing yyyy-MM-dd date inputs (intersected during filtering, with a
  // dismissable banner so operators can tell why the queue is narrowed).
  const initialDeepLink = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("reviewReason");
    const fromParam = params.get("from");
    const toParam = params.get("to");
    const fromMs = fromParam ? new Date(fromParam).getTime() : NaN;
    const toMs = toParam ? new Date(toParam).getTime() : NaN;
    const hasRange = !Number.isNaN(fromMs) && !Number.isNaN(toMs);
    if (!reason && !hasRange) return null;
    return {
      reason: reason && reason.trim() ? reason.trim() : null,
      range: hasRange ? { fromMs, toMs, fromIso: fromParam!, toIso: toParam! } : null,
    };
  }, []);
  const [urlPreciseRange, setUrlPreciseRange] = useState<
    { fromMs: number; toMs: number; fromIso: string; toIso: string } | null
  >(initialDeepLink?.range ?? null);
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (!initialDeepLink) return;
    deepLinkAppliedRef.current = true;
    if (initialDeepLink.reason) {
      setReasonFilter(initialDeepLink.reason);
    }
    // The reason chip + precise-range banner are enough; the existing date
    // inputs intentionally stay empty so the operator can widen the window
    // without losing the precise overlay until they explicitly clear it.
  }, [initialDeepLink, setReasonFilter]);
  const clearUrlPreciseRange = () => {
    setUrlPreciseRange(null);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("from");
      url.searchParams.delete("to");
      window.history.replaceState({}, "", url.toString());
    }
  };
  const focusHandledRef = useRef(false);
  useEffect(() => {
    if (!focusId || focusHandledRef.current) return;
    if (!data) return;
    const found = (data.items || []).some((it) => it.decision.id === focusId);
    if (!found) return;
    focusHandledRef.current = true;
    const el = document.getElementById(`decision-${focusId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
    el.classList.add("ring-2", "ring-yellow-400", "ring-offset-2");
    window.setTimeout(() => {
      el.classList.remove("ring-2", "ring-yellow-400", "ring-offset-2");
    }, 3000);
  }, [focusId, data]);

  const reasonSummary = data?.reasonSummary;
  const dismissSummary = data?.dismissSummary;
  const previousDismissSummary = data?.previousDismissSummary ?? null;
  const resolutionSummary = data?.resolutionSummary;
  const previousResolutionSummary = data?.previousResolutionSummary ?? null;
  const sourceCounts = data?.sourceCounts;
  const thresholds = data?.thresholds;

  type AlertSettings = {
    enabled: boolean;
    countThreshold: number;
    ageHoursThreshold: number;
    cooldownMinutes: number;
    slackChannel: string;
    recipientEmails: string[];
    lastSentAt: string | null;
    lastStatus: AlertStatus | null;
    cycleState: "alerted" | "cleared";
    lastClearedAt: string | null;
    eventHistory: AlertEvent[];
  };
  type AlertEventChannel = {
    attempted: boolean;
    sent: boolean;
    recipients?: number;
    skipReason?: string;
  };
  type AlertEvent = {
    type: "backed-up" | "cleared";
    at: string;
    pendingCount: number;
    oldestAgeHours: number | null;
    slack?: AlertEventChannel;
    email?: AlertEventChannel;
    inApp?: AlertEventChannel;
    legacy?: boolean;
  };
  type AlertStatus = {
    evaluatedAt: string;
    pendingCount: number;
    oldestAgeHours: number | null;
    breached: boolean;
    breachReasons: string[];
    notificationSent: boolean;
    slackSent: boolean;
    slackAttempted?: boolean;
    slackSkipReason?: string;
    emailSent: boolean;
    emailRecipients: number;
    emailAttempted?: boolean;
    emailSkipReason?: string;
    inAppRecipients: number;
    skipReason?: string;
    cleared?: boolean;
  };
  type AlertSettingsResponse = {
    settings: AlertSettings;
    metrics: { pendingCount: number; oldestAgeHours: number | null; oldestCreatedAt: string | null };
  };

  const alertSettingsQuery = useQuery<AlertSettingsResponse>({
    queryKey: ["/api/admin/zoom/review-queue/alert-settings"],
    queryFn: async () => {
      const res = await fetch("/api/admin/zoom/review-queue/alert-settings", { credentials: "include" });
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
  });

  // Aging pills reuse the operator-tuned alert threshold so "amber" on a row
  // and "backed up" in the alert card agree on what counts as old.
  const agingThresholdHours =
    alertSettingsQuery.data?.settings.ageHoursThreshold ?? DEFAULT_AGING_THRESHOLD_HOURS;

  const [alertForm, setAlertForm] = useState<AlertSettings | null>(null);
  const [recipientEmailsText, setRecipientEmailsText] = useState<string>("");
  const [alertHistoryFilter, setAlertHistoryFilter] = useState<
    "all" | "backed-up" | "cleared"
  >("all");
  const [alertHistoryVisibleCount, setAlertHistoryVisibleCount] = useState<number>(
    ALERT_HISTORY_PAGE_SIZE,
  );
  useEffect(() => {
    setAlertHistoryVisibleCount(ALERT_HISTORY_PAGE_SIZE);
  }, [alertHistoryFilter]);
  useEffect(() => {
    if (alertForm === null && alertSettingsQuery.data) {
      setAlertForm(alertSettingsQuery.data.settings);
      setRecipientEmailsText(
        (alertSettingsQuery.data.settings.recipientEmails ?? []).join(", "),
      );
    }
  }, [alertForm, alertSettingsQuery.data]);

  const parseEmailsText = (text: string): string[] =>
    text
      .split(/[,\s;]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const errorMessage = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const saveAlertSettings = useMutation<AlertSettings, Error, Partial<AlertSettings>>({
    meta: { silent: true },
    mutationFn: async (vars) => {
      const res = await apiRequest("PATCH", "/api/admin/zoom/review-queue/alert-settings", vars);
      const body = (await res.json()) as { settings: AlertSettings };
      return body.settings;
    },
    onSuccess: (settings) => {
      toast({ title: "Saved", description: "Alert settings updated." });
      setAlertForm(settings);
      setRecipientEmailsText((settings.recipientEmails ?? []).join(", "));
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue/alert-settings"] }); // fire-and-forget: cache refresh only
    },
    onError: (err) =>
      toast({ title: "Save failed", description: errorMessage(err), variant: "destructive" }),
  });

  const sendTestAlert = useMutation<AlertStatus, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/zoom/review-queue/alert-settings/test", {});
      const body = (await res.json()) as { status: AlertStatus };
      return body.status;
    },
    onSuccess: (status) => {
      if (status.notificationSent) {
        const emailPart = status.emailSent
          ? `yes (${status.emailRecipients})`
          : status.emailSkipReason
            ? `no (${formatEmailSkipReason(status.emailSkipReason)})`
            : "no";
        const slackPart = status.slackSent
          ? "yes"
          : status.slackSkipReason
            ? `no (${formatSlackSkipReason(status.slackSkipReason)})`
            : "no";
        toast({
          title: "Alert sent",
          description:
            `Slack: ${slackPart}, ` +
            `email: ${emailPart}, ` +
            `in-app recipients: ${status.inAppRecipients}`,
        });
      } else {
        toast({
          title: "No notification dispatched",
          description:
            "No channel succeeded. Check that Slack is connected, that email alerts are set up (SendGrid connected, a sender chosen, and a recipient list saved), or that some users have admin roles.",
          variant: "destructive",
        });
      }
      void qc.invalidateQueries({ queryKey: ["/api/admin/zoom/review-queue/alert-settings"] }); // fire-and-forget: cache refresh only
    },
    onError: (err) =>
      toast({ title: "Test failed", description: errorMessage(err), variant: "destructive" }),
  });

  const sendPreviewBackedUpAlert = useMutation<AlertStatus, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/zoom/review-queue/alert-settings/test",
        { forceBackedUp: true },
      );
      const body = (await res.json()) as { status: AlertStatus };
      return body.status;
    },
    onSuccess: (status) => {
      if (status.notificationSent) {
        const slackPart = status.slackSent
          ? "yes"
          : status.slackSkipReason
            ? `no (${formatSlackSkipReason(status.slackSkipReason)})`
            : "no";
        toast({
          title: "Backed-up preview sent",
          description:
            `Slack: ${slackPart}, ` +
            `in-app recipients: ${status.inAppRecipients}. Cooldown and cycle state unchanged.`,
        });
      } else {
        toast({
          title: "No notification dispatched",
          description:
            "No channel succeeded. Check that Slack is connected or that some users have admin roles.",
          variant: "destructive",
        });
      }
    },
    onError: (err) =>
      toast({
        title: "Backed-up preview failed",
        description: errorMessage(err),
        variant: "destructive",
      }),
  });

  const sendTestClearedAlert = useMutation<AlertStatus, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/zoom/review-queue/alert-settings/test",
        { forceCleared: true },
      );
      const body = (await res.json()) as { status: AlertStatus };
      return body.status;
    },
    onSuccess: (status) => {
      if (status.notificationSent) {
        const slackPart = status.slackSent
          ? "yes"
          : status.slackSkipReason
            ? `no (${formatSlackSkipReason(status.slackSkipReason)})`
            : "no";
        toast({
          title: "All-clear preview sent",
          description:
            `Slack: ${slackPart}, ` +
            `in-app recipients: ${status.inAppRecipients}. Cycle state unchanged.`,
        });
      } else {
        toast({
          title: "No notification dispatched",
          description:
            "No channel succeeded. Check that Slack is connected or that some users have admin roles.",
          variant: "destructive",
        });
      }
    },
    onError: (err) =>
      toast({
        title: "Test all-clear failed",
        description: errorMessage(err),
        variant: "destructive",
      }),
  });

  // ============================================
  // Task #1144 — Live progress for the older review-queue body backfill
  // (originally mirrored the signals-backfill card, whose routes were deleted
  // in Task #2637 and whose card/count query were removed in Task #5004).
  // Unlike signals, this backfill has no cursor: the candidate query anti-joins against
  // agent_match_decisions so each apply page naturally skips already-recorded
  // rows. Chain stop condition is `recorded === 0` so we don't spin on the
  // same skipped (no-prior-client / unparseable) rows that anti-join can't
  // exclude on its own.
  // ============================================
  type BodyBackfillReport = {
    scanned: number;
    recorded: number;
    wouldRecord: number;
    skippedAlreadyHasDecision: number;
    skippedNoPriorClient: number;
    skippedUnparseable: number;
    recoveredFromLink: number;
    recoveredFromRerunContent: number;
    recoveredFromRerunParticipants: number;
    errors: Array<{ recordId: string; message: string }>;
  };
  type BodyBackfillRunResult = { report: BodyBackfillReport; summaryText: string };

  const bodyBackfillCountQuery = useQuery<{ count: number }>({
    queryKey: ["/api/integrations/zoom/review-queue/backfill/count"],
    queryFn: async () => {
      const res = await fetch(
        "/api/integrations/zoom/review-queue/backfill/count",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Failed: ${res.status}`);
      return res.json();
    },
  });

  type BodyBackfillAggregate = {
    pagesRun: number;
    scanned: number;
    recorded: number;
    wouldRecord: number;
    skippedAlreadyHasDecision: number;
    skippedNoPriorClient: number;
    skippedUnparseable: number;
    recoveredFromLink: number;
    recoveredFromRerunContent: number;
    recoveredFromRerunParticipants: number;
    errors: Array<{ recordId: string; message: string }>;
    initialRemaining: number | null;
  };

  const emptyBodyBackfillAggregate = (
    initialRemaining: number | null,
  ): BodyBackfillAggregate => ({
    pagesRun: 0,
    scanned: 0,
    recorded: 0,
    wouldRecord: 0,
    skippedAlreadyHasDecision: 0,
    skippedNoPriorClient: 0,
    skippedUnparseable: 0,
    recoveredFromLink: 0,
    recoveredFromRerunContent: 0,
    recoveredFromRerunParticipants: 0,
    errors: [],
    initialRemaining,
  });

  const mergeBodyBackfillAggregate = (
    prev: BodyBackfillAggregate,
    page: BodyBackfillReport,
  ): BodyBackfillAggregate => ({
    pagesRun: prev.pagesRun + 1,
    scanned: prev.scanned + page.scanned,
    recorded: prev.recorded + page.recorded,
    wouldRecord: prev.wouldRecord + page.wouldRecord,
    skippedAlreadyHasDecision: prev.skippedAlreadyHasDecision + page.skippedAlreadyHasDecision,
    skippedNoPriorClient: prev.skippedNoPriorClient + page.skippedNoPriorClient,
    skippedUnparseable: prev.skippedUnparseable + page.skippedUnparseable,
    recoveredFromLink: prev.recoveredFromLink + page.recoveredFromLink,
    recoveredFromRerunContent: prev.recoveredFromRerunContent + page.recoveredFromRerunContent,
    recoveredFromRerunParticipants: prev.recoveredFromRerunParticipants + page.recoveredFromRerunParticipants,
    errors: [...prev.errors, ...page.errors],
    initialRemaining: prev.initialRemaining,
  });

  const [bodyBackfillProgress, setBodyBackfillProgress] = useState<{
    kind: "dry-run" | "apply";
    agg: BodyBackfillAggregate;
    lastSummaryText: string;
  } | null>(null);

  const [bodyBackfillChainActive, setBodyBackfillChainActive] = useState(false);
  const [bodyBackfillStopRequested, setBodyBackfillStopRequested] = useState(false);
  const bodyBackfillChainActiveRef = useRef(false);
  const bodyBackfillStopRequestedRef = useRef(false);
  const setBodyBackfillChain = (active: boolean) => {
    bodyBackfillChainActiveRef.current = active;
    setBodyBackfillChainActive(active);
  };
  const setBodyBackfillStopRequest = (requested: boolean) => {
    bodyBackfillStopRequestedRef.current = requested;
    setBodyBackfillStopRequested(requested);
  };

  const bodyBackfillDryRun = useMutation<BodyBackfillRunResult, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/integrations/zoom/review-queue/backfill/dry-run",
        {},
      );
      return (await res.json()) as BodyBackfillRunResult;
    },
    onSuccess: (result) => {
      setBodyBackfillProgress((prev) => {
        // Dry-run has no cursor — each call returns the same first page,
        // so reset the aggregate instead of accumulating duplicate counts.
        const base = emptyBodyBackfillAggregate(
          bodyBackfillCountQuery.data?.count ?? null,
        );
        return {
          kind: "dry-run",
          agg: mergeBodyBackfillAggregate(base, result.report),
          lastSummaryText: result.summaryText,
        };
      });
      toast({
        title: "Dry-run page complete",
        description: `Would record ${result.report.wouldRecord} of ${result.report.scanned} scanned this page.`,
      });
    },
    onError: (err) =>
      toast({
        title: "Dry-run failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      }),
  });

  const bodyBackfillApply = useMutation<BodyBackfillRunResult, Error, void>({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/integrations/zoom/review-queue/backfill/apply",
        { confirm: true },
      );
      return (await res.json()) as BodyBackfillRunResult;
    },
    onSuccess: (result) => {
      let mergedAgg: BodyBackfillAggregate | undefined;
      setBodyBackfillProgress((prev) => {
        const base =
          prev && prev.kind === "apply"
            ? prev.agg
            : emptyBodyBackfillAggregate(
                bodyBackfillCountQuery.data?.count ?? null,
              );
        const merged = mergeBodyBackfillAggregate(base, result.report);
        mergedAgg = merged;
        return {
          kind: "apply",
          agg: merged,
          lastSummaryText: result.summaryText,
        };
      });
      void qc.invalidateQueries({
        queryKey: ["/api/integrations/zoom/review-queue/backfill/count"],
      }); // fire-and-forget: cache refresh only
      if (bodyBackfillChainActiveRef.current) {
        const stopRequested = bodyBackfillStopRequestedRef.current;
        // Stop when nothing was newly recorded this page — either we drained
        // the backlog or only un-recordable rows remain (skipped no_prior_client
        // / unparseable would otherwise re-appear on every page).
        const morePages = result.report.recorded > 0;
        if (!stopRequested && morePages) {
          bodyBackfillApply.mutate();
          return;
        }
        setBodyBackfillChain(false);
        setBodyBackfillStopRequest(false);
        const recorded = mergedAgg?.recorded ?? 0;
        const pages = mergedAgg?.pagesRun ?? 0;
        const stoppedReason = stopRequested
          ? "stopped by operator"
          : result.report.recorded === 0
            ? "0 rows recorded this page — only un-recordable rows remain"
            : "drained";
        toast({
          title: stopRequested ? "Backfill chain stopped" : "Backfill chain complete",
          description: `Recorded ${recorded} row${recorded === 1 ? "" : "s"} across ${pages} page${pages === 1 ? "" : "s"} (${stoppedReason}).`,
        });
      } else {
        toast({
          title: "Backfill page applied",
          description: `Recorded ${result.report.recorded} row${result.report.recorded === 1 ? "" : "s"} this page.`,
        });
      }
    },
    onError: (err) => {
      if (bodyBackfillChainActiveRef.current) {
        setBodyBackfillChain(false);
        setBodyBackfillStopRequest(false);
      }
      toast({
        title: "Apply failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const startBodyBackfillChain = () => {
    setBodyBackfillStopRequest(false);
    setBodyBackfillProgress({
      kind: "apply",
      agg: emptyBodyBackfillAggregate(
        bodyBackfillCountQuery.data?.count ?? null,
      ),
      lastSummaryText: "",
    });
    setBodyBackfillChain(true);
    bodyBackfillApply.mutate();
  };

  const reasonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of allItems) {
      if (item.decision.reviewReason) set.add(item.decision.reviewReason);
    }
    return Array.from(set).sort();
  }, [allItems]);

  useEffect(() => {
    if (!data) return;
    if (reasonFilter !== "all" && !reasonOptions.includes(reasonFilter)) {
      setReasonFilter("all");
    }
  }, [data, reasonFilter, reasonOptions, setReasonFilter]);

  const items = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const toMs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null;
    return allItems.filter((item) => {
      if (reasonFilter !== "all" && item.decision.reviewReason !== reasonFilter) {
        return false;
      }
      // #734: approved / reassigned / dismissed / reopened are filtered
      // server-side now; only "unresolved" still needs a client-side guard
      // since the server may return resolved rows when includeResolved=true.
      if (resolutionFilter === "unresolved" && item.decision.reviewResolution) {
        return false;
      }
      if (fromMs !== null || toMs !== null || urlPreciseRange) {
        const ts = item.rawRecord?.timestamp ? new Date(item.rawRecord.timestamp).getTime() : NaN;
        if (Number.isNaN(ts)) return false;
        if (fromMs !== null && ts < fromMs) return false;
        if (toMs !== null && ts > toMs) return false;
        // Task #1157: precise [from, to) overlay from a sparkline-bar deep link.
        if (urlPreciseRange) {
          if (ts < urlPreciseRange.fromMs) return false;
          if (ts >= urlPreciseRange.toMs) return false;
        }
      }
      if (!q) return true;
      const haystack = [
        item.suggestedClientName,
        item.priorClientName,
        item.rawRecord?.title,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allItems, searchQuery, reasonFilter, resolutionFilter, fromDate, toDate, urlPreciseRange]);

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <PageHeader
        title="Zoom Review Queue"
        backHref="/admin/zoom"
        subtitle="Borderline Zoom calls awaiting human review."
        className="mb-6"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ResetSavedViewButton
              storageKeys={persistedViewKeys}
              onReset={handleResetSavedView}
              testId="button-reset-saved-view-zoom-queue"
            />
            <Select value={windowSel} onValueChange={setWindowSel}>
              <SelectTrigger className="w-44" aria-label="Time window" data-testid="select-window">
                <SelectValue placeholder="Window" />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value} data-testid={`option-window-${opt.value}`}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Switch
                checked={includeResolved}
                onCheckedChange={setIncludeResolved}
                aria-label="Show resolved"
                data-testid="switch-include-resolved"
              />
              <span className="text-sm">Show resolved</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        }
      />

      {urlPreciseRange && (
        <div
          className="mb-6 -mt-2 inline-flex items-center gap-2 text-xs px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-900"
          data-testid="banner-sparkline-range"
          data-range-from={urlPreciseRange.fromIso}
          data-range-to={urlPreciseRange.toIso}
        >
          <span>
            Showing items from{" "}
            <span className="font-mono">
              {new Date(urlPreciseRange.fromMs).toLocaleString()}
            </span>{" "}
            →{" "}
            <span className="font-mono">
              {new Date(urlPreciseRange.toMs).toLocaleString()}
            </span>{" "}
            (from sparkline)
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-indigo-900 hover:text-indigo-950"
            onClick={clearUrlPreciseRange}
            data-testid="button-clear-sparkline-range"
          >
            Clear range
          </Button>
        </div>
      )}

      <Card className="mb-4" data-testid="card-backlog-trend">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Unmatched backlog{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (Task #993 routes every non-deterministic Zoom call here)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {trendQuery.isLoading || !trendQuery.data ? (
            <div className="text-sm text-muted-foreground" data-testid="text-trend-loading">
              Loading trend…
            </div>
          ) : (
            (() => {
              const t = trendQuery.data;
              const delta24 = t.pendingCount - t.pendingCount24hAgo;
              const delta7d = t.pendingCount - t.pendingCount7dAgo;
              const TrendIcon = (delta: number) =>
                delta > 0 ? (
                  <TrendingUp className="h-4 w-4 inline text-rose-600" />
                ) : delta < 0 ? (
                  <TrendingDown className="h-4 w-4 inline text-emerald-600" />
                ) : (
                  <Minus className="h-4 w-4 inline text-muted-foreground" />
                );
              const deltaClass = (d: number) =>
                d > 0
                  ? "text-rose-700 dark:text-rose-400 font-medium"
                  : d < 0
                  ? "text-emerald-700 dark:text-emerald-400 font-medium"
                  : "text-muted-foreground";
              const fmtDelta = (d: number) =>
                d === 0 ? "no change" : d > 0 ? `+${d}` : `${d}`;
              return (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div data-testid="stat-trend-pending-now">
                    <div className="text-xs uppercase text-muted-foreground">Pending now</div>
                    <div className="text-3xl font-semibold mt-1" data-testid="text-trend-pending-now">
                      {t.pendingCount}
                    </div>
                  </div>
                  <div data-testid="stat-trend-vs-24h">
                    <div className="text-xs uppercase text-muted-foreground">vs. 24h ago</div>
                    <div className="text-2xl font-semibold mt-1">
                      {TrendIcon(delta24)}{" "}
                      <span className={deltaClass(delta24)} data-testid="text-trend-delta-24h">
                        {fmtDelta(delta24)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5" data-testid="text-trend-flow-24h">
                      +{t.createdLast24h} in · −{t.resolvedLast24h} out
                    </div>
                  </div>
                  <div data-testid="stat-trend-vs-7d">
                    <div className="text-xs uppercase text-muted-foreground">vs. 7d ago</div>
                    <div className="text-2xl font-semibold mt-1">
                      {TrendIcon(delta7d)}{" "}
                      <span className={deltaClass(delta7d)} data-testid="text-trend-delta-7d">
                        {fmtDelta(delta7d)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5" data-testid="text-trend-flow-7d">
                      +{t.createdLast7d} in · −{t.resolvedLast7d} out
                    </div>
                  </div>
                  <div data-testid="stat-trend-net">
                    <div className="text-xs uppercase text-muted-foreground">7d net flow</div>
                    <div className="text-2xl font-semibold mt-1">
                      {(() => {
                        const net = t.createdLast7d - t.resolvedLast7d;
                        return (
                          <span className={deltaClass(net)} data-testid="text-trend-net-7d">
                            {net > 0 ? `+${net}` : net}
                          </span>
                        );
                      })()}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      arrivals minus resolutions
                    </div>
                  </div>
                </div>
              );
            })()
          )}
        </CardContent>
      </Card>

      <Card className="mb-4" data-testid="card-alert-settings">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {alertForm?.enabled ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
            Backed-up queue alerts
            {alertForm?.cycleState === "alerted" ? (
              <span
                className="text-xs font-normal px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300"
                data-testid="badge-cycle-alerted"
              >
                Currently alerted
              </span>
            ) : alertForm?.lastClearedAt ? (
              <span
                className="text-xs font-normal px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-300"
                data-testid="badge-cycle-cleared"
              >
                Cleared {format(new Date(alertForm.lastClearedAt), "PPp")}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Notify admins when the Zoom review queue grows beyond a count or age threshold.
            Notifications are sent to a Slack channel (if configured), to any email recipients
            you list (if SendGrid is connected and a sender is chosen), and as in-app alerts to
            account managers, team leads, and CEO users.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">Pending count</div>
              <div className="text-lg font-semibold" data-testid="text-current-count">
                {alertSettingsQuery.data?.metrics.pendingCount ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">Oldest pending</div>
              <div className="text-lg font-semibold" data-testid="text-oldest-age">
                {alertSettingsQuery.data?.metrics.oldestAgeHours != null
                  ? `${alertSettingsQuery.data.metrics.oldestAgeHours.toFixed(1)}h`
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">Last alert sent</div>
              <div className="text-sm" data-testid="text-last-sent">
                {alertForm?.lastSentAt
                  ? format(new Date(alertForm.lastSentAt), "PPp")
                  : "Never"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">
                Last all-clear sent
              </div>
              <div className="text-sm" data-testid="text-last-cleared">
                {alertForm?.lastClearedAt
                  ? format(new Date(alertForm.lastClearedAt), "PPp")
                  : "Never"}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <Switch
                checked={!!alertForm?.enabled}
                onCheckedChange={(v) => alertForm && setAlertForm({ ...alertForm, enabled: v })}
                aria-label="Enable alerts"
                data-testid="switch-alerts-enabled"
              />
              <span className="text-sm">Enable alerts</span>
            </div>
          </div>

          {alertForm?.lastStatus && (
            <div
              className="rounded border bg-muted/40 p-3"
              data-testid="section-last-check-channels"
            >
              <div className="text-xs text-muted-foreground uppercase mb-2">
                Last check delivery
                {alertForm.lastStatus.evaluatedAt
                  ? ` · ${format(new Date(alertForm.lastStatus.evaluatedAt), "PPp")}`
                  : ""}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <div data-testid="text-channel-slack">
                  <span className="text-muted-foreground">Slack:</span>{" "}
                  {!alertForm.slackChannel ? (
                    <span className="text-muted-foreground">not configured</span>
                  ) : alertForm.lastStatus.slackSent ? (
                    <span className="text-emerald-700 font-medium">yes</span>
                  ) : alertForm.lastStatus.slackAttempted ? (
                    <span className="text-rose-700 font-medium">
                      failed
                      {alertForm.lastStatus.slackSkipReason
                        ? `: ${formatSlackSkipReason(alertForm.lastStatus.slackSkipReason)}`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {alertForm.lastStatus.slackSkipReason
                        ? formatSlackSkipReason(alertForm.lastStatus.slackSkipReason)
                        : "not sent"}
                    </span>
                  )}
                </div>
                <div data-testid="text-channel-email">
                  <span className="text-muted-foreground">Email:</span>{" "}
                  {alertForm.lastStatus.emailSent ? (
                    <span className="text-emerald-700 font-medium">
                      yes ({alertForm.lastStatus.emailRecipients} recipient
                      {alertForm.lastStatus.emailRecipients === 1 ? "" : "s"})
                    </span>
                  ) : alertForm.lastStatus.emailAttempted ? (
                    <span className="text-rose-700 font-medium">
                      failed
                      {alertForm.lastStatus.emailSkipReason
                        ? `: ${formatEmailSkipReason(alertForm.lastStatus.emailSkipReason)}`
                        : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {alertForm.lastStatus.emailSkipReason
                        ? formatEmailSkipReason(alertForm.lastStatus.emailSkipReason)
                        : "not sent"}
                    </span>
                  )}
                </div>
                <div data-testid="text-channel-inapp">
                  <span className="text-muted-foreground">In-app:</span>{" "}
                  <span
                    className={
                      alertForm.lastStatus.inAppRecipients > 0
                        ? "text-emerald-700 font-medium"
                        : "text-muted-foreground"
                    }
                  >
                    {alertForm.lastStatus.inAppRecipients} recipient
                    {alertForm.lastStatus.inAppRecipients === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground uppercase mb-1 block">
                Count threshold
              </label>
              <Input
                type="number"
                min={1}
                value={alertForm?.countThreshold ?? ""}
                onChange={(e) =>
                  alertForm &&
                  setAlertForm({ ...alertForm, countThreshold: Number(e.target.value) })
                }
                aria-label="Count threshold"
                data-testid="input-count-threshold"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase mb-1 block">
                Age threshold (hours)
              </label>
              <Input
                type="number"
                min={1}
                value={alertForm?.ageHoursThreshold ?? ""}
                onChange={(e) =>
                  alertForm &&
                  setAlertForm({ ...alertForm, ageHoursThreshold: Number(e.target.value) })
                }
                aria-label="Age threshold (hours)"
                data-testid="input-age-threshold"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase mb-1 block">
                Cooldown (minutes)
              </label>
              <Input
                type="number"
                min={1}
                value={alertForm?.cooldownMinutes ?? ""}
                onChange={(e) =>
                  alertForm &&
                  setAlertForm({ ...alertForm, cooldownMinutes: Number(e.target.value) })
                }
                aria-label="Cooldown (minutes)"
                data-testid="input-cooldown"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase mb-1 block">
                Slack channel ID
              </label>
              <Input
                placeholder="C0123ABCDEF"
                value={alertForm?.slackChannel ?? ""}
                onChange={(e) =>
                  alertForm && setAlertForm({ ...alertForm, slackChannel: e.target.value })
                }
                aria-label="Slack channel ID"
                data-testid="input-slack-channel"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground uppercase mb-1 block">
              Email recipients (comma-separated)
            </label>
            <Input
              placeholder="alice@example.com, bob@example.com"
              value={recipientEmailsText}
              onChange={(e) => {
                setRecipientEmailsText(e.target.value);
                if (alertForm) {
                  setAlertForm({
                    ...alertForm,
                    recipientEmails: parseEmailsText(e.target.value),
                  });
                }
              }}
              aria-label="Email recipients (comma-separated)"
              data-testid="input-recipient-emails"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Optional. Emails are sent in addition to Slack and in-app alerts. Failures here
              don't block the other channels.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => alertForm && saveAlertSettings.mutate(alertForm)}
              disabled={!alertForm || saveAlertSettings.isPending}
              data-testid="button-save-alert-settings"
            >
              {saveAlertSettings.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : null}
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendTestAlert.mutate()}
              disabled={
                sendTestAlert.isPending ||
                sendTestClearedAlert.isPending ||
                sendPreviewBackedUpAlert.isPending
              }
              data-testid="button-test-alert"
            >
              {sendTestAlert.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              Send test alert now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendPreviewBackedUpAlert.mutate()}
              disabled={
                sendPreviewBackedUpAlert.isPending ||
                sendTestAlert.isPending ||
                sendTestClearedAlert.isPending
              }
              data-testid="button-preview-backed-up-alert"
              title="Preview the backed-up Slack and in-app message without touching the cooldown, cycle state, or event history"
            >
              {sendPreviewBackedUpAlert.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              Preview backed-up alert
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => sendTestClearedAlert.mutate()}
              disabled={
                sendTestClearedAlert.isPending ||
                sendTestAlert.isPending ||
                sendPreviewBackedUpAlert.isPending
              }
              data-testid="button-test-cleared-alert"
              title="Preview the all-clear Slack and in-app message without changing the persisted cycle state"
            >
              {sendTestClearedAlert.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              Send test all-clear now
            </Button>
            {alertForm?.lastStatus?.skipReason && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="text-last-skip-reason"
              >
                Last check skipped: {alertForm.lastStatus.skipReason}
              </span>
            )}
          </div>

          <div className="pt-2" data-testid="section-alert-history">
            <div className="flex items-center flex-wrap gap-2 mb-2">
              <div className="text-xs text-muted-foreground uppercase">
                Recent alert events
              </div>
              {alertForm && alertForm.eventHistory && alertForm.eventHistory.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setAlertHistoryFilter((f) => (f === "backed-up" ? "all" : "backed-up"))
                    }
                    aria-pressed={alertHistoryFilter === "backed-up"}
                    title={
                      alertHistoryFilter === "backed-up"
                        ? "Click to show all events"
                        : "Click to show only backed-up events"
                    }
                    className={
                      "text-xs font-medium px-2 py-0.5 rounded border bg-amber-100 text-amber-800 border-amber-300 cursor-pointer hover:bg-amber-200 " +
                      (alertHistoryFilter === "backed-up"
                        ? "ring-2 ring-amber-500 ring-offset-1"
                        : "")
                    }
                    data-testid="badge-history-count-backed-up"
                  >
                    Backed up:{" "}
                    {alertForm.eventHistory.filter((e) => e.type === "backed-up").length}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setAlertHistoryFilter((f) => (f === "cleared" ? "all" : "cleared"))
                    }
                    aria-pressed={alertHistoryFilter === "cleared"}
                    title={
                      alertHistoryFilter === "cleared"
                        ? "Click to show all events"
                        : "Click to show only all-clear events"
                    }
                    className={
                      "text-xs font-medium px-2 py-0.5 rounded border bg-emerald-100 text-emerald-800 border-emerald-300 cursor-pointer hover:bg-emerald-200 " +
                      (alertHistoryFilter === "cleared"
                        ? "ring-2 ring-emerald-500 ring-offset-1"
                        : "")
                    }
                    data-testid="badge-history-count-cleared"
                  >
                    All clear:{" "}
                    {alertForm.eventHistory.filter((e) => e.type === "cleared").length}
                  </button>
                  {alertHistoryFilter !== "all" ? (
                    <button
                      type="button"
                      onClick={() => setAlertHistoryFilter("all")}
                      className="text-xs px-2 py-0.5 rounded border bg-muted/40 text-muted-foreground border-muted hover:bg-muted cursor-pointer"
                      data-testid="button-history-filter-clear"
                    >
                      Clear filter
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {alertForm && alertForm.eventHistory && alertForm.eventHistory.length > 0 ? (() => {
              const filteredEvents = alertForm.eventHistory.filter((e) =>
                alertHistoryFilter === "all" ? true : e.type === alertHistoryFilter,
              );
              if (filteredEvents.length === 0) {
                return (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="text-alert-history-filter-empty"
                  >
                    No {alertHistoryFilter === "backed-up" ? "backed-up" : "all-clear"} events
                    in recent history.
                  </p>
                );
              }
              const visibleEvents = filteredEvents.slice(0, alertHistoryVisibleCount);
              const remainingCount = filteredEvents.length - visibleEvents.length;
              return (
              <>
              <ul className="space-y-1">
                {visibleEvents.map((evt, idx) => {
                  const ageStr =
                    evt.oldestAgeHours != null ? `${evt.oldestAgeHours.toFixed(1)}h` : "n/a";
                  const isBackedUp = evt.type === "backed-up";
                  type ChannelKey = "slack" | "email" | "inApp";
                  const channelLabel: Record<ChannelKey, string> = {
                    slack: "Slack",
                    email: "Email",
                    inApp: "In-app",
                  };
                  const formatChannelSkipReason = (
                    key: ChannelKey,
                    reason: string,
                  ): string => {
                    if (key === "email") return formatEmailSkipReason(reason);
                    if (key === "slack") return formatSlackSkipReason(reason);
                    return reason;
                  };
                  const renderChannelBadge = (key: ChannelKey) => {
                    const ch = evt[key];
                    const label = channelLabel[key];
                    if (!ch) {
                      return (
                        <span
                          key={key}
                          className="text-xs px-1.5 py-0.5 rounded border bg-muted/40 text-muted-foreground border-muted"
                          data-testid={`badge-alert-event-${key}-${idx}`}
                          title="No data recorded"
                        >
                          {label}: —
                        </span>
                      );
                    }
                    if (ch.sent) {
                      const recipientSuffix =
                        typeof ch.recipients === "number" && ch.recipients > 0 && key !== "slack"
                          ? ` (${ch.recipients})`
                          : "";
                      return (
                        <span
                          key={key}
                          className="text-xs px-1.5 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200"
                          data-testid={`badge-alert-event-${key}-${idx}`}
                          title={`${label} delivered${recipientSuffix}`}
                        >
                          {label}: sent{recipientSuffix}
                        </span>
                      );
                    }
                    // Not sent — show the reason inline so admins can audit
                    // historical alerts without hovering for tooltips. Covers
                    // both attempted-and-failed and never-attempted paths.
                    if (!ch.attempted && !ch.skipReason) {
                      return (
                        <span
                          key={key}
                          className="text-xs px-1.5 py-0.5 rounded border bg-muted/40 text-muted-foreground border-muted"
                          data-testid={`badge-alert-event-${key}-${idx}`}
                          title="Not attempted"
                        >
                          {label}: not attempted
                        </span>
                      );
                    }
                    const detail = ch.skipReason
                      ? formatChannelSkipReason(key, ch.skipReason)
                      : "failed";
                    const tone = ch.attempted
                      ? "bg-rose-50 text-rose-700 border-rose-200"
                      : "bg-muted/40 text-muted-foreground border-muted";
                    return (
                      <span
                        key={key}
                        className={"text-xs px-1.5 py-0.5 rounded border " + tone}
                        data-testid={`badge-alert-event-${key}-${idx}`}
                        title={`${label}: ${detail}`}
                      >
                        {label}: {detail}
                      </span>
                    );
                  };
                  const hasChannelData = !!(evt.slack || evt.email || evt.inApp);
                  return (
                    <li
                      key={`${evt.at}-${idx}`}
                      className={
                        // Task #4372 (audit P2-14): rail colors from the shared
                        // status tokens (left edge is the only visible border).
                        "rounded border-l-2 pl-2 py-1 " +
                        (isBackedUp
                          ? "border-l-status-warn bg-amber-50/50"
                          : "border-l-status-ok bg-emerald-50/50")
                      }
                      data-testid={`row-alert-event-${idx}`}
                    >
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        <span
                          className={
                            "text-xs font-medium px-2 py-0.5 rounded border " +
                            (isBackedUp
                              ? "bg-amber-100 text-amber-800 border-amber-300"
                              : "bg-emerald-100 text-emerald-800 border-emerald-300")
                          }
                          data-testid={`badge-alert-event-type-${idx}`}
                        >
                          {isBackedUp ? "Backed up" : "All clear"}
                        </span>
                        <span
                          className="text-muted-foreground"
                          data-testid={`text-alert-event-at-${idx}`}
                        >
                          {format(new Date(evt.at), "PPp")}
                        </span>
                        <span
                          className="text-muted-foreground"
                          data-testid={`text-alert-event-stats-${idx}`}
                        >
                          · {evt.pendingCount} pending · oldest {ageStr}
                        </span>
                      </div>
                      {hasChannelData ? (
                        <div
                          className="flex items-center flex-wrap gap-1.5 mt-1"
                          data-testid={`row-alert-event-channels-${idx}`}
                        >
                          {renderChannelBadge("slack")}
                          {renderChannelBadge("email")}
                          {renderChannelBadge("inApp")}
                        </div>
                      ) : evt.legacy ? (
                        <div
                          className="flex items-center gap-1.5 mt-1"
                          data-testid={`row-alert-event-legacy-${idx}`}
                        >
                          <span
                            className="text-xs px-1.5 py-0.5 rounded border bg-slate-100 text-slate-700 border-slate-300"
                            data-testid={`badge-alert-event-legacy-${idx}`}
                            title="This alert was recorded before per-channel delivery tracking shipped (Task #653). Delivery outcomes were not captured."
                          >
                            No data — pre-#653
                          </span>
                        </div>
                      ) : (
                        <div
                          className="text-xs text-muted-foreground mt-1"
                          data-testid={`text-alert-event-no-channels-${idx}`}
                        >
                          Delivery details not recorded for this event.
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {remainingCount > 0 ? (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setAlertHistoryVisibleCount((c) => c + ALERT_HISTORY_PAGE_SIZE)
                    }
                    className="text-xs px-2 py-1 rounded border bg-muted/40 text-foreground border-muted hover:bg-muted cursor-pointer"
                    data-testid="button-alert-history-show-more"
                  >
                    Show {Math.min(remainingCount, ALERT_HISTORY_PAGE_SIZE)} more
                  </button>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="text-alert-history-count"
                  >
                    Showing {visibleEvents.length} of {filteredEvents.length}
                  </span>
                </div>
              ) : filteredEvents.length > ALERT_HISTORY_PAGE_SIZE ? (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAlertHistoryVisibleCount(ALERT_HISTORY_PAGE_SIZE)}
                    className="text-xs px-2 py-1 rounded border bg-muted/40 text-foreground border-muted hover:bg-muted cursor-pointer"
                    data-testid="button-alert-history-collapse"
                  >
                    Collapse
                  </button>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid="text-alert-history-count"
                  >
                    Showing all {filteredEvents.length}
                  </span>
                </div>
              ) : null}
              </>
              );
            })() : (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-alert-history-empty"
              >
                No alerts have been sent yet.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      {(() => {
        const remaining = bodyBackfillCountQuery.data?.count;
        if (bodyBackfillCountQuery.isLoading) return null;
        if (remaining === 0 && !bodyBackfillProgress) return null;
        const busy = bodyBackfillDryRun.isPending || bodyBackfillApply.isPending;
        const progress = bodyBackfillProgress;
        const agg = progress?.agg ?? null;
        const initial = agg?.initialRemaining ?? null;
        const processedSoFar = agg?.scanned ?? 0;
        const totalForBar =
          initial !== null ? initial : processedSoFar + (remaining ?? 0);
        const percent =
          totalForBar > 0
            ? Math.min(100, Math.round((processedSoFar / totalForBar) * 100))
            : 0;
        return (
          <Card className="mb-4" data-testid="card-body-backfill">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                Older Zoom records missing a review-queue row
                {typeof remaining === "number" && (
                  <span
                    className="text-xs font-normal px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300"
                    data-testid="badge-body-backfill-count"
                  >
                    {remaining} remaining
                  </span>
                )}
                {bodyBackfillChainActive && (
                  <span
                    className="text-xs font-normal px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-300 flex items-center gap-1"
                    data-testid="badge-body-backfill-chain-active"
                  >
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Chain running
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                These older Zoom recordings were demoted to review by a manual
                reprocess but never had an entry created in the review queue.
                Run a dry-run to see what would be recorded, apply one page at a
                time, or apply remaining to chain pages automatically until the
                count stops moving.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || bodyBackfillChainActive || remaining === 0}
                  onClick={() => bodyBackfillDryRun.mutate()}
                  data-testid="button-body-backfill-dry-run"
                >
                  {bodyBackfillDryRun.isPending && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Run dry-run
                </Button>
                <ConfirmActionDialog
                  title="Apply one page of the body backfill?"
                  description={`This records up to 1000 of the ${remaining ?? "?"} remaining rows into the review queue. Rows already recorded are skipped.`}
                  confirmLabel="Apply one page"
                  testId="dialog-confirm-body-backfill-apply"
                  onConfirm={() => bodyBackfillApply.mutate()}
                  trigger={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || bodyBackfillChainActive || remaining === 0}
                  data-testid="button-body-backfill-apply"
                >
                  {bodyBackfillApply.isPending && !bodyBackfillChainActive && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Apply one page
                </Button>
                  }
                />
                <ConfirmActionDialog
                  title="Apply all remaining body-backfill pages?"
                  description={`This chains page-by-page until all ${remaining ?? "?"} rows are processed (or only un-recordable rows remain). You can stop after any page with the Stop button.`}
                  confirmLabel="Apply remaining"
                  testId="dialog-confirm-body-backfill-apply-remaining"
                  onConfirm={() => startBodyBackfillChain()}
                  trigger={
                <Button
                  size="sm"
                  disabled={busy || bodyBackfillChainActive || remaining === 0}
                  data-testid="button-body-backfill-apply-remaining"
                >
                  {bodyBackfillChainActive && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  Apply remaining
                </Button>
                  }
                />
                {bodyBackfillChainActive && (
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={bodyBackfillStopRequested}
                    onClick={() => setBodyBackfillStopRequest(true)}
                    data-testid="button-body-backfill-stop"
                  >
                    {bodyBackfillStopRequested ? "Stopping…" : "Stop after this page"}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => bodyBackfillCountQuery.refetch()}
                  disabled={bodyBackfillChainActive}
                  data-testid="button-body-backfill-refresh"
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Refresh count
                </Button>
                {progress && !bodyBackfillChainActive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setBodyBackfillProgress(null)}
                    data-testid="button-body-backfill-reset"
                  >
                    Reset progress
                  </Button>
                )}
              </div>
              {agg && agg.pagesRun > 0 && (
                <div
                  className="rounded border bg-muted/40 p-3 space-y-2"
                  data-testid="section-body-backfill-progress"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground uppercase">
                      Cumulative {progress?.kind === "apply" ? "apply" : "dry-run"} progress
                    </span>
                    <span data-testid="text-body-backfill-pages">
                      {agg.pagesRun} page{agg.pagesRun === 1 ? "" : "s"} run
                    </span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span data-testid="text-body-backfill-progress-counts">
                        Processed {processedSoFar.toLocaleString()}
                        {initial !== null
                          ? ` of ~${initial.toLocaleString()}`
                          : ""}
                        {typeof remaining === "number"
                          ? ` · ${remaining.toLocaleString()} still remaining`
                          : ""}
                      </span>
                      <span data-testid="text-body-backfill-progress-percent">
                        {percent}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-muted rounded overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${percent}%` }}
                        data-testid="bar-body-backfill-progress"
                      />
                    </div>
                  </div>
                  <div
                    className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono"
                    data-testid="grid-body-backfill-totals"
                  >
                    <div>
                      <span className="text-muted-foreground">Recorded</span>{" "}
                      <span data-testid="text-body-backfill-total-recorded">
                        {agg.recorded}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Would record</span>{" "}
                      <span data-testid="text-body-backfill-total-would-record">
                        {agg.wouldRecord}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Skipped (has decision)</span>{" "}
                      {agg.skippedAlreadyHasDecision}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Skipped (no prior client)</span>{" "}
                      {agg.skippedNoPriorClient}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Skipped (unparseable)</span>{" "}
                      {agg.skippedUnparseable}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Recovered (link)</span>{" "}
                      {agg.recoveredFromLink}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Recovered (content)</span>{" "}
                      {agg.recoveredFromRerunContent}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Recovered (participants)</span>{" "}
                      {agg.recoveredFromRerunParticipants}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Errors</span>{" "}
                      <span data-testid="text-body-backfill-total-errors">
                        {agg.errors.length}
                      </span>
                    </div>
                  </div>
                  {agg.errors.length > 0 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        Show {agg.errors.length} error{agg.errors.length === 1 ? "" : "s"}
                      </summary>
                      <ul
                        className="mt-1 space-y-0.5 font-mono"
                        data-testid="list-body-backfill-errors"
                      >
                        {agg.errors.slice(0, 25).map((e, i) => (
                          <li key={`${e.recordId}-${i}`}>
                            {e.recordId.slice(0, 8)}…: {e.message}
                          </li>
                        ))}
                        {agg.errors.length > 25 && (
                          <li className="text-muted-foreground">
                            … and {agg.errors.length - 25} more
                          </li>
                        )}
                      </ul>
                    </details>
                  )}
                  {progress?.lastSummaryText && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        Show last page report
                      </summary>
                      <pre
                        className="mt-1 whitespace-pre-wrap font-mono"
                        data-testid="text-body-backfill-summary"
                      >
                        {progress.lastSummaryText}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })()}
      {sourceCounts && (
        <Card className="mb-4" data-testid="card-source-counts">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Backfill vs live breakdown{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({windowSel === "all" ? "all time" : `last ${windowSel} day${windowSel === "1" ? "" : "s"}`}
                {includeResolved ? " · including resolved" : " · pending only"})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(
                [
                  {
                    key: "backfill" as const,
                    label: "Historical backfill",
                    count: sourceCounts.backfill,
                    hint: "Reprocessed from older Zoom history.",
                  },
                  {
                    key: "live" as const,
                    label: "Live",
                    count: sourceCounts.live,
                    hint: "Routed from current Zoom activity.",
                  },
                  {
                    key: "total" as const,
                    label: "Total",
                    count: sourceCounts.total,
                    hint: "All routed-to-review calls in this window.",
                  },
                ]
              ).map(({ key, label, count, hint }) => {
                const pct =
                  key === "total" || sourceCounts.total === 0
                    ? null
                    : Math.round((count / sourceCounts.total) * 100);
                const filterValue: "all" | "backfill" | "live" =
                  key === "total" ? "all" : key;
                const isActive =
                  key === "total" ? sourceFilter === "all" : sourceFilter === key;
                return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => {
                      if (key !== "total" && sourceFilter === key) {
                        setSourceFilter("all");
                      } else {
                        setSourceFilter(filterValue);
                      }
                    }}
                    aria-pressed={isActive}
                    className={`text-left rounded-md border p-3 transition-colors hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      isActive ? "border-primary bg-primary/10 ring-1 ring-primary" : ""
                    }`}
                    data-testid={`stat-source-${key}`}
                  >
                    <div className="text-xs uppercase text-muted-foreground">{label}</div>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span
                        className="text-2xl font-semibold"
                        data-testid={`stat-source-count-${key}`}
                      >
                        {count}
                      </span>
                      {pct !== null && (
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`stat-source-pct-${key}`}
                        >
                          {pct}%
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">{hint}</div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
      {reasonSummary && thresholds && (
        <Card className="mb-4" data-testid="card-reason-summary">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Routed-to-review breakdown{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({windowSel === "all" ? "all time" : `last ${windowSel} day${windowSel === "1" ? "" : "s"}`} ·{" "}
                <span data-testid="text-summary-total">{reasonSummary.total}</span> total)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {(["weak_signal_only", "contact_name_only_weak", "solo_internal_participants"] as const).map(
                (reason) => {
                  const count = reasonSummary.byReason[reason] || 0;
                  const pct = reasonSummary.total > 0 ? Math.round((count / reasonSummary.total) * 100) : 0;
                  return (
                    <div
                      key={reason}
                      className="rounded-md border p-3"
                      data-testid={`stat-reason-${reason}`}
                    >
                      <div className="text-xs uppercase text-muted-foreground">{reasonLabel(reason)}</div>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="text-2xl font-semibold" data-testid={`stat-count-${reason}`}>
                          {count}
                        </span>
                        <span className="text-xs text-muted-foreground">{pct}%</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {thresholdHintForReason(reason, thresholds)}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
            {Object.entries(reasonSummary.byReason)
              .filter(
                ([k]) =>
                  !["weak_signal_only", "contact_name_only_weak", "solo_internal_participants"].includes(k),
              )
              .map(([k, v]) => (
                <div key={k} className="text-xs text-muted-foreground" data-testid={`stat-other-${k}`}>
                  {reasonLabel(k)}: {v}
                </div>
              ))}
            <div className="text-xs text-muted-foreground border-t pt-2">
              Current thresholds — strong-signal weight ≥ {thresholds.strongSignalMinWeight},
              short-token max length {thresholds.shortTokenMaxLen}.
            </div>
          </CardContent>
        </Card>
      )}

      {dismissSummary && (
        <Card className="mb-4" data-testid="card-dismiss-summary">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Dismiss reason breakdown{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({windowSel === "all" ? "all time" : `last ${windowSel} day${windowSel === "1" ? "" : "s"}`} ·{" "}
                <span data-testid="text-dismiss-summary-total">{dismissSummary.total}</span> dismissed)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {dismissSummary.total === 0 ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="text-dismiss-summary-empty"
              >
                No dismissed Zoom calls in this window.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {dismissReasons.map((reason) => {
                    const count = dismissSummary.byReason[reason] || 0;
                    const pct =
                      dismissSummary.total > 0
                        ? Math.round((count / dismissSummary.total) * 100)
                        : 0;
                    const prev = previousDismissSummary
                      ? previousDismissSummary.byReason[reason] || 0
                      : null;
                    const delta = prev != null ? count - prev : null;
                    const isActive = dismissReasonFilter === reason;
                    const disabled = count === 0 && !isActive;
                    return (
                      <button
                        key={reason}
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          const next = isActive ? "all" : reason;
                          setDismissReasonFilter(next);
                          // #734: a dismiss-reason filter only makes sense
                          // for dismissed rows; snap the resolution chip to
                          // "dismissed" so the two filters intersect cleanly.
                          if (
                            next !== "all" &&
                            resolutionFilter !== "all" &&
                            resolutionFilter !== "dismissed"
                          ) {
                            setResolutionFilter("dismissed");
                          }
                        }}
                        className={`text-left rounded-md border p-3 transition-colors ${
                          isActive
                            ? "border-primary ring-2 ring-primary/40 bg-primary/5"
                            : "hover:bg-muted/50"
                        } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                        title={
                          isActive
                            ? "Click to clear this filter"
                            : `Filter the queue to dismissed calls with reason: ${dismissReasonLabels[reason]}`
                        }
                        data-testid={`stat-dismiss-${reason}`}
                        aria-pressed={isActive}
                      >
                        <div className="text-xs uppercase text-muted-foreground">
                          {dismissReasonLabels[reason]}
                        </div>
                        <div className="flex items-baseline gap-2 mt-1">
                          <span
                            className="text-2xl font-semibold"
                            data-testid={`stat-dismiss-count-${reason}`}
                          >
                            {count}
                          </span>
                          <span className="text-xs text-muted-foreground">{pct}%</span>
                        </div>
                        {delta != null && (
                          <div
                            className={`text-xs mt-1 ${
                              delta > 0
                                ? "text-red-600 dark:text-red-400"
                                : delta < 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : "text-muted-foreground"
                            }`}
                            data-testid={`stat-dismiss-delta-${reason}`}
                            title={`Previous equal-length window: ${prev}`}
                          >
                            {delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${Math.abs(delta)}` : "— 0"} vs prior {windowSel}d
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
                {Object.entries(dismissSummary.byReason)
                  .filter(([k]) => !(dismissReasons as readonly string[]).includes(k))
                  .map(([k, v]) => {
                    const filterKey = k === "unspecified" ? "unspecified" : null;
                    const isActive = filterKey !== null && dismissReasonFilter === filterKey;
                    if (filterKey) {
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            const next = isActive ? "all" : filterKey;
                            setDismissReasonFilter(next);
                            if (
                              next !== "all" &&
                              resolutionFilter !== "all" &&
                              resolutionFilter !== "dismissed"
                            ) {
                              setResolutionFilter("dismissed");
                            }
                          }}
                          className={`text-xs underline-offset-2 hover:underline ${
                            isActive ? "text-primary-ink font-medium" : "text-muted-foreground"
                          }`}
                          data-testid={`stat-dismiss-other-${k}`}
                          aria-pressed={isActive}
                        >
                          {k}: {v}
                        </button>
                      );
                    }
                    return (
                      <div
                        key={k}
                        className="text-xs text-muted-foreground"
                        data-testid={`stat-dismiss-other-${k}`}
                      >
                        {k}: {v}
                      </div>
                    );
                  })}
                {dismissReasonFilter !== "all" && (
                  <div
                    className="flex items-center gap-2 text-xs"
                    data-testid="banner-dismiss-reason-filter"
                  >
                    <Badge variant="secondary" data-testid="badge-active-dismiss-filter">
                      Filtering queue to dismissed ·{" "}
                      {dismissReasonFilter === "unspecified"
                        ? "unspecified"
                        : dismissReasonLabels[dismissReasonFilter as DismissReason] ||
                          dismissReasonFilter}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDismissReasonFilter("all")}
                      data-testid="button-clear-dismiss-filter"
                    >
                      Clear filter
                    </Button>
                  </div>
                )}
                {dismissSummary.recentOtherNotes.length > 0 && (
                  <div className="border-t pt-2">
                    <div className="text-xs uppercase text-muted-foreground mb-1">
                      Recent “other” notes
                    </div>
                    <ul className="space-y-1">
                      {dismissSummary.recentOtherNotes.map((n, i) => (
                        <li
                          key={i}
                          className="text-xs text-muted-foreground"
                          data-testid={`text-dismiss-other-note-${i}`}
                        >
                          <span className="text-foreground">“{n.note}”</span>
                          {n.reviewedAt && (
                            <span className="ml-2">
                              · {format(new Date(n.reviewedAt), "MMM d, yyyy")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <Input
          placeholder="Search by client name or call title…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="sm:max-w-sm"
          aria-label="Search by client name or call title"
          data-testid="input-search"
        />
        <Select value={reasonFilter} onValueChange={setReasonFilter}>
          <SelectTrigger className="sm:w-64" aria-label="Filter by reason" data-testid="select-reason-filter">
            <SelectValue placeholder="Filter by reason" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="option-reason-all">
              All reasons
            </SelectItem>
            {reasonOptions.map((reason) => (
              <SelectItem key={reason} value={reason} data-testid={`option-reason-${reason}`}>
                {reason}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sourceFilter}
          onValueChange={(v) => setSourceFilter(v as "all" | "backfill" | "live")}
        >
          <SelectTrigger className="sm:w-56" aria-label="Filter by source" data-testid="select-source-filter">
            <SelectValue placeholder="Filter by source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" data-testid="option-source-all">
              All sources
              {data?.sourceCounts ? ` (${data.sourceCounts.total})` : ""}
            </SelectItem>
            <SelectItem value="backfill" data-testid="option-source-backfill">
              Historical backfill only
              {data?.sourceCounts ? ` (${data.sourceCounts.backfill})` : ""}
            </SelectItem>
            <SelectItem value="live" data-testid="option-source-live">
              Live reprocess only
              {data?.sourceCounts ? ` (${data.sourceCounts.live})` : ""}
            </SelectItem>
          </SelectContent>
        </Select>
        {/* #734: resolution chips are always visible; picking a specific
            outcome triggers a server-side query that returns the right rows
            even when the includeResolved switch is off. */}
        <div className="flex items-start gap-1 flex-wrap" data-testid="group-resolution-filter">
          <span className="text-xs text-muted-foreground mr-1 mt-2">Resolution:</span>
          {([
            { key: "all", label: "All" },
            { key: "unresolved", label: "Unresolved", bucket: "unresolved" as const },
            { key: "approved", label: "Approved", bucket: "approved" as const },
            { key: "reassigned", label: "Reassigned", bucket: "reassigned" as const },
            { key: "dismissed", label: "Dismissed", bucket: "dismissed" as const },
            { key: "reopened", label: "Re-opened", bucket: "reopened" as const },
          ] as Array<{ key: ResolutionFilter; label: string; bucket?: keyof ResolutionBuckets }>).map(({ key, label, bucket }) => {
            const active = resolutionFilter === key;
            const count =
              bucket && resolutionSummary
                ? resolutionSummary.byResolution[bucket] ?? 0
                : null;
            const prev =
              bucket && previousResolutionSummary
                ? previousResolutionSummary.byResolution[bucket] ?? 0
                : null;
            const delta = count != null && prev != null ? count - prev : null;
            const isEmpty = bucket != null && count === 0;
            return (
              <div key={key} className="flex flex-col items-stretch">
                <Button
                  size="sm"
                  variant={active ? "default" : "outline"}
                  className={`h-7 px-2 text-xs ${
                    isEmpty && !active ? "opacity-60" : ""
                  }`}
                  onClick={() => {
                    const next: ResolutionFilter = active ? "all" : key;
                    setResolutionFilter(next);
                    // #734: dismiss-reason filter only makes sense when the
                    // resolution is "dismissed" or "all". Clear it
                    // automatically when the user picks an incompatible
                    // resolution so the server isn't asked for a contradictory
                    // intersection.
                    if (
                      dismissReasonFilter !== "all" &&
                      next !== "all" &&
                      next !== "dismissed"
                    ) {
                      setDismissReasonFilter("all");
                    }
                  }}
                  data-testid={`button-resolution-${key}`}
                  title={
                    active
                      ? "Click to clear this filter"
                      : `Filter the queue to ${label.toLowerCase()} decisions`
                  }
                  aria-pressed={active}
                >
                  {label}
                  {count != null && (
                    <span
                      className="ml-1.5 tabular-nums"
                      data-testid={`text-resolution-count-${key}`}
                    >
                      {count}
                    </span>
                  )}
                </Button>
                {delta != null && windowSel !== "all" && (
                  <span
                    className={`text-xs mt-0.5 text-center tabular-nums ${
                      delta > 0
                        ? "text-red-600 dark:text-red-400"
                        : delta < 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground"
                    }`}
                    data-testid={`text-resolution-delta-${key}`}
                    title={`Previous equal-length window: ${prev}`}
                  >
                    {delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${Math.abs(delta)}` : "— 0"} vs prior {windowSel}d
                  </span>
                )}
              </div>
            );
          })}
          {resolutionFilter !== "all" && (
            <div
              className="flex items-center gap-2 ml-2"
              data-testid="banner-resolution-filter"
            >
              <Badge variant="secondary" data-testid="badge-active-resolution-filter">
                Filtering queue to{" "}
                {resolutionFilter === "unresolved"
                  ? "unresolved"
                  : resolutionFilter === "reopened"
                    ? "re-opened"
                    : resolutionFilter}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setResolutionFilter("all")}
                data-testid="button-clear-resolution-filter"
              >
                Clear filter
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-muted-foreground whitespace-nowrap">From</label>
          <Input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFromDate(e.target.value)}
            className="sm:w-40"
            aria-label="From date"
            data-testid="input-date-from"
          />
          <label className="text-xs text-muted-foreground whitespace-nowrap">To</label>
          <Input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setToDate(e.target.value)}
            className="sm:w-40"
            aria-label="To date"
            data-testid="input-date-to"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const today = format(new Date(), "yyyy-MM-dd");
              setFromDate(today);
              setToDate(today);
            }}
            data-testid="button-preset-today"
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const now = new Date();
              const from = new Date(now);
              from.setDate(now.getDate() - 6);
              setFromDate(format(from, "yyyy-MM-dd"));
              setToDate(format(now, "yyyy-MM-dd"));
            }}
            data-testid="button-preset-last-7-days"
          >
            Last 7 days
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const now = new Date();
              const from = new Date(now.getFullYear(), now.getMonth(), 1);
              setFromDate(format(from, "yyyy-MM-dd"));
              setToDate(format(now, "yyyy-MM-dd"));
            }}
            data-testid="button-preset-this-month"
          >
            This month
          </Button>
          {(fromDate || toDate) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromDate("");
                setToDate("");
              }}
              data-testid="button-clear-date-range"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-empty">
            {allItems.length === 0
              ? "No Zoom calls currently in the review queue."
              : "No Zoom calls match your search or filter."}
          </CardContent>
        </Card>
      )}

      {(() => {
        // Task #996: bulk-action toolbar. Only unresolved rows are eligible
        // (resolved rows already have a recorded outcome and don't need a
        // second one). Selecting "select all" only ticks the unresolved rows
        // visible in the current filter so the operator never accidentally
        // dismisses or reassigns more than they can see.
        const unresolvedItems = items.filter((it) => !it.decision.reviewResolution);
        const visibleSelected = unresolvedItems.filter((it) => selectedIds.has(it.decision.id));
        const allChecked =
          unresolvedItems.length > 0 && visibleSelected.length === unresolvedItems.length;
        const someChecked =
          visibleSelected.length > 0 && visibleSelected.length < unresolvedItems.length;
        if (unresolvedItems.length === 0) return null;
        return (
          <Card className="mb-3" data-testid="card-bulk-actions">
            <CardContent className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={allChecked ? true : someChecked ? "indeterminate" : false}
                    onCheckedChange={(v) => {
                      if (v) {
                        const next = new Set(selectedIds);
                        for (const it of unresolvedItems) next.add(it.decision.id);
                        setSelectedIds(next);
                      } else {
                        const next = new Set(selectedIds);
                        for (const it of unresolvedItems) next.delete(it.decision.id);
                        setSelectedIds(next);
                      }
                    }}
                    data-testid="checkbox-bulk-select-all"
                    aria-label="Select all visible unresolved Zoom calls"
                  />
                  <span className="text-sm" data-testid="text-bulk-selected-count">
                    {visibleSelected.length} selected
                    <span className="text-muted-foreground ml-1">
                      / {unresolvedItems.length} unresolved on screen
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 ml-auto">
                  <ClientPicker
                    clients={clientOptions}
                    isLoading={clientsQuery.isLoading}
                    isError={clientsQuery.isError}
                    onRetry={() => clientsQuery.refetch()}
                    value={bulkAssignClientId}
                    onChange={setBulkAssignClientId}
                    placeholder="Assign all selected to firm…"
                    testId="picker-bulk-assign"
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      bulkApprove.mutate({
                        decisionIds: Array.from(selectedIds),
                        approvedClientId: bulkAssignClientId.trim() || undefined,
                      })
                    }
                    disabled={
                      bulkApprove.isPending ||
                      bulkDismiss.isPending ||
                      selectedIds.size === 0 ||
                      !bulkAssignClientId.trim()
                    }
                    data-testid="button-bulk-assign"
                    title="Approve every selected row and attribute it to the picked firm. Rows that already had a different suggested client are recorded as 'reassigned' in the audit trail."
                  >
                    {bulkApprove.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-1" />
                    )}
                    Bulk assign ({selectedIds.size})
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedIds(new Set())}
                    disabled={selectedIds.size === 0}
                    data-testid="button-bulk-clear"
                  >
                    Clear
                  </Button>
                  {/* Audit P2-12: the destructive bulk action sits apart (divider)
                      and rests as a calm critical outline — the red fill lives on
                      the dialog's confirm, the actual commit point. */}
                  <div className="h-5 w-px bg-border" aria-hidden="true" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-status-critical/40 text-status-critical hover:bg-status-critical/10 hover:text-status-critical"
                    onClick={() => setBulkDismissOpen(true)}
                    disabled={
                      bulkDismiss.isPending || bulkApprove.isPending || selectedIds.size === 0
                    }
                    data-testid="button-bulk-dismiss"
                    title="Dismiss every selected row with a shared reason; each row is stamped 'dismissed:<reason>' in the audit trail just like a single dismissal."
                  >
                    {bulkDismiss.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <XCircle className="h-4 w-4 mr-1" />
                    )}
                    Bulk dismiss ({selectedIds.size})
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })()}

      <div className="space-y-4">
        {items.map((item) => {
          const d = item.decision;
          const r = item.rawRecord;
          const isResolved = !!d.reviewResolution;
          const candidates: any[] = Array.isArray(d.candidateShortlistJson) ? d.candidateShortlistJson : [];
          const reasoning = d.semanticReasoningSummary || "";
          const isComparativeNone = reasoning.includes(COMPARATIVE_NONE_PREFIX);
          const isComparativeNotChosen = reasoning.includes(COMPARATIVE_NOT_CHOSEN_PREFIX);
          const isBackfill = isBackfillItem(item);
          return (
            <Card key={d.id} id={`decision-${d.id}`} data-testid={`card-decision-${d.id}`} className="scroll-mt-20">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  {!isResolved && (
                    <Checkbox
                      className="mt-1"
                      checked={selectedIds.has(d.id)}
                      onCheckedChange={(v) => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(d.id);
                          else next.delete(d.id);
                          return next;
                        });
                      }}
                      data-testid={`checkbox-select-${d.id}`}
                      aria-label="Select this Zoom call for bulk action"
                    />
                  )}
                  <div className="flex-1">
                    <CardTitle className="text-base" data-testid={`text-title-${d.id}`}>
                      {r?.title || "Zoom call"}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3" data-testid={`text-meta-${d.id}`}>
                      <span>{r?.timestamp ? format(new Date(r.timestamp), "PPp") : "—"}</span>
                      {r?.rawPayloadJson?.duration ? <span>{r.rawPayloadJson.duration} min</span> : null}
                      {r?.rawPayloadJson?.hostName ? <span>Host: {r.rawPayloadJson.hostName}</span> : null}
                      {Array.isArray(r?.participantsJson) && r.participantsJson.length > 0 ? (
                        <span>
                          Participants: {r.participantsJson.map((p: any) => p.name || p.email).filter(Boolean).join(", ")}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {!isResolved &&
                      (() => {
                        const ageHours = pendingAgeHours(d.createdAt);
                        const isAging = ageHours !== null && ageHours >= agingThresholdHours;
                        return isAging ? (
                          <StatusPill
                            tone="warn"
                            dot
                            testId={`badge-status-${d.id}`}
                            title={`Waiting ${formatAgeShort(ageHours)} — past the ${agingThresholdHours}h aging threshold`}
                          >
                            Pending review · {formatAgeShort(ageHours)}
                          </StatusPill>
                        ) : (
                          <StatusPill testId={`badge-status-${d.id}`}>Pending review</StatusPill>
                        );
                      })()}
                    {isBackfill && (
                      <StatusPill
                        tone="info"
                        testId={`badge-backfill-${d.id}`}
                        title="Created by the historical Zoom review-queue backfill (task #451)"
                      >
                        Historical backfill
                      </StatusPill>
                    )}
                    {isComparativeNone && (
                      <StatusPill
                        testId={`badge-comparative-none-${d.id}`}
                        title="The AI compared every shortlisted candidate and rejected them all"
                      >
                        AI rejected shortlist
                      </StatusPill>
                    )}
                    {isResolved && (
                      <StatusPill testId={`badge-resolution-${d.id}`}>
                        {d.reviewResolution}
                      </StatusPill>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-muted-foreground uppercase">Suggested client</div>
                    <div data-testid={`text-suggested-${d.id}`}>
                      {d.clientId ? (
                        <>
                          <span title={d.clientId}>
                            {resolveFirmName(d.clientId, item.suggestedClientName)}
                          </span>{" "}
                          <span className="text-muted-foreground">
                            ({(d.confidenceScore * 100).toFixed(0)}%)
                          </span>
                        </>
                      ) : (
                        <span className="italic text-muted-foreground" data-testid={`text-no-candidate-${d.id}`}>
                          No candidate — pick a client below to approve
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground uppercase">Prior attribution</div>
                    <div data-testid={`text-prior-${d.id}`}>
                      {d.priorClientId ? (
                        <span title={d.priorClientId}>
                          {resolveFirmName(d.priorClientId, item.priorClientName)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-muted-foreground uppercase">Guardrail reason</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusPill testId={`badge-reason-${d.id}`}>
                        {reasonLabel(d.reviewReason)}
                      </StatusPill>
                      {(() => {
                        const signals: SignalRow[] = Array.isArray(d.supportingSignalsJson)
                          ? (d.supportingSignalsJson as SignalRow[])
                          : [];
                        if (signals.length === 0) return null;
                        return (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`text-signal-weights-${d.id}`}
                          >
                            Signals:{" "}
                            {signals
                              .map((s) =>
                                `${s.type}=${typeof s.weight === "number" ? s.weight.toFixed(2) : "?"}`,
                              )
                              .join(", ")}
                          </span>
                        );
                      })()}
                    </div>
                    {thresholds && thresholdHintForReason(d.reviewReason, thresholds) && (
                      <div
                        className="text-xs text-muted-foreground mt-1"
                        data-testid={`text-reason-hint-${d.id}`}
                      >
                        {thresholdHintForReason(d.reviewReason, thresholds)}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground hidden" data-testid={`text-reason-${d.id}`}>
                      {d.reviewReason || "—"}
                    </div>
                  </div>
                  {d.explanationSummary && (
                    <div className="md:col-span-2">
                      <div className="text-xs text-muted-foreground uppercase">Summary</div>
                      <div className="text-sm" data-testid={`text-summary-${d.id}`}>
                        {stripBackfillPrefix(d.explanationSummary)}
                      </div>
                    </div>
                  )}
                  {reasoning && (
                    <div className="md:col-span-2">
                      <div className="text-xs text-muted-foreground uppercase">
                        {isComparativeNone
                          ? "AI comparative reasoning (rejected shortlist)"
                          : isComparativeNotChosen
                          ? "AI comparative reasoning (not chosen)"
                          : "AI reasoning"}
                      </div>
                      <div
                        className="text-sm rounded-md p-2 border bg-muted/40 border-transparent"
                        data-testid={`text-reasoning-${d.id}`}
                      >
                        {stripComparativePrefix(reasoning)}
                      </div>
                    </div>
                  )}
                  {r?.contentPreview && (
                    <div className="md:col-span-2">
                      <div className="text-xs text-muted-foreground uppercase">Preview</div>
                      <div className="text-sm">{r.contentPreview}</div>
                    </div>
                  )}
                </div>

                {candidates.length > 0 && (
                  <div className="border rounded-md p-3 bg-muted/30">
                    <div className="text-xs font-medium text-muted-foreground mb-2 uppercase">
                      Candidate shortlist
                    </div>
                    <ul className="space-y-2 text-sm">
                      {candidates.slice(0, 5).map((c: any, idx: number) => {
                        const hint: string =
                          (typeof c.semanticReasoningSummary === "string" && c.semanticReasoningSummary) ||
                          (typeof c.explanationSummary === "string" && c.explanationSummary) ||
                          "";
                        const candidateNotChosen = hint.includes(COMPARATIVE_NOT_CHOSEN_PREFIX);
                        const candidateNone = hint.includes(COMPARATIVE_NONE_PREFIX);
                        return (
                          <li key={idx} className="space-y-0.5" data-testid={`row-candidate-${d.id}-${idx}`}>
                            <div className="flex items-center justify-between">
                              <span title={c.clientId || undefined}>
                                {resolveFirmName(c.clientId, c.firmName)}
                              </span>
                              <span className="text-muted-foreground">
                                {typeof c.confidenceScore === "number"
                                  ? `${(c.confidenceScore * 100).toFixed(0)}%`
                                  : ""}
                                {c.matchedOn ? ` · ${c.matchedOn}` : ""}
                                {candidateNotChosen ? " · not chosen" : ""}
                                {candidateNone ? " · rejected" : ""}
                              </span>
                            </div>
                            {hint && (
                              <div
                                className="text-xs text-muted-foreground italic pl-1 border-l-2 border-muted"
                                data-testid={`text-candidate-hint-${d.id}-${idx}`}
                              >
                                {stripComparativePrefix(hint)}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {isResolved && (
                  <div className="flex flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground">
                    <span data-testid={`text-resolved-meta-${d.id}`}>
                      {d.reviewResolution === "dismissed" ? "Dismissed" : "Resolved"}
                      {d.reviewedAt ? ` ${format(new Date(d.reviewedAt), "PPp")}` : ""}
                      {(d.reopenCount ?? 0) > 0 && d.reopenedAt
                        ? ` · last re-opened ${format(new Date(d.reopenedAt), "PPp")} (${d.reopenCount}×)`
                        : ""}
                      {(d.reopenCount ?? 0) > 0 && (item.reopenedByUserName || d.reopenedByUserId) ? (
                        <>
                          {" by "}
                          <span
                            title={item.reopenedByUserEmail || undefined}
                            data-testid={`text-reopened-by-${d.id}`}
                          >
                            {item.reopenedByUserName || d.reopenedByUserId}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setReopenTargetId(d.id)}
                      disabled={reopen.isPending && reopenTargetId === d.id}
                      data-testid={`button-reopen-${d.id}`}
                    >
                      <RotateCcw className="h-4 w-4 mr-1" />
                      Re-open
                    </Button>
                  </div>
                )}

                {!isResolved && (
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    {d.clientId && (
                      <Button
                        size="sm"
                        onClick={() => approve.mutate({ id: d.id })}
                        disabled={approve.isPending}
                        data-testid={`button-approve-${d.id}`}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" />
                        Approve
                      </Button>
                    )}
                    <div className="flex items-center gap-2">
                      <ClientPicker
                        clients={clientOptions}
                        isLoading={clientsQuery.isLoading}
                        isError={clientsQuery.isError}
                        onRetry={() => clientsQuery.refetch()}
                        value={reassignFor[d.id] || ""}
                        onChange={(id) =>
                          setReassignFor((prev) => ({ ...prev, [d.id]: id }))
                        }
                        placeholder={d.clientId ? "Reassign to firm…" : "Pick a firm to approve"}
                        testId={`picker-reassign-${d.id}`}
                      />
                      <Button
                        size="sm"
                        variant={d.clientId ? "outline" : "default"}
                        onClick={() =>
                          approve.mutate({
                            id: d.id,
                            approvedClientId: reassignFor[d.id]?.trim() || undefined,
                          })
                        }
                        disabled={approve.isPending || !reassignFor[d.id]?.trim()}
                        data-testid={`button-reassign-${d.id}`}
                      >
                        {d.clientId ? (
                          "Reassign"
                        ) : (
                          <>
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            Approve with client
                          </>
                        )}
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDismissTargetId(d.id)}
                      disabled={dismiss.isPending}
                      data-testid={`button-dismiss-${d.id}`}
                    >
                      <XCircle className="h-4 w-4 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      <DismissReasonDialog
        open={dismissTargetId !== null}
        onOpenChange={(open) => !open && setDismissTargetId(null)}
        isPending={dismiss.isPending}
        onConfirm={(reason, note) => {
          if (dismissTargetId) {
            dismiss.mutate({ id: dismissTargetId, reason, reasonNote: note });
          }
        }}
      />
      <DismissReasonDialog
        open={bulkDismissOpen}
        onOpenChange={(open) => {
          if (!open && !bulkDismiss.isPending) setBulkDismissOpen(false);
        }}
        isPending={bulkDismiss.isPending}
        title={`Dismiss ${selectedIds.size} Zoom call${selectedIds.size === 1 ? "" : "s"}`}
        description="Pick a single reason that applies to every selected row. Each row gets its own audit-trail entry stamped 'dismissed:<reason>'."
        onConfirm={(reason, note) => {
          bulkDismiss.mutate({
            decisionIds: Array.from(selectedIds),
            reason,
            reasonNote: note,
          });
        }}
      />
      <ReopenConfirmDialog
        open={reopenTargetId !== null}
        onOpenChange={(open) => {
          if (!open && !reopen.isPending) setReopenTargetId(null);
        }}
        isPending={reopen.isPending}
        onConfirm={() => {
          if (reopenTargetId) {
            reopen.mutate({ id: reopenTargetId });
          }
        }}
      />
    </div>
  );
}
