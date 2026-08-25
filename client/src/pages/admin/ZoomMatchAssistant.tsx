// Task #4057 — Zoom Transcript Match Assistant.
//
// Separate manual tool linked from the Zoom integration panel: sweeps the
// past 12 months of Zoom cloud recordings (durable background job), drives
// transcript backfill for calls that never got one, runs a cheap-tier AI
// pass over each transcript-bearing call still unmatched (no client),
// and presents this review workbench — call summary, names involved, AI
// guess with confidence/rationale — where the operator confirms or overrides
// each assignment. Guesses are NEVER auto-applied; the Assign action reuses
// the existing manual-reassign semantics (audit stamps included).

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import {
  Check,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Wand2,
  AlertCircle,
  Users,
} from "lucide-react";

/** Mirrors LOW_CONFIDENCE_THRESHOLD in server/services/zoomTranscriptMatchAssistant.ts. */
const LOW_CONFIDENCE_THRESHOLD = 0.6;

const UNATTRIBUTED = "__unattributed__";

type SweepStatus = {
  id: string;
  status: "running" | "completed" | "failed";
  phase: "discovery" | "transcripts" | "analysis" | "done";
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  lastError: string | null;
  windowsTotal: number;
  windowsDone: number;
  counters: Record<string, number>;
  analysesPending: number;
  stalled: boolean;
};

type WorkbenchCall = {
  id: string;
  timestamp: string;
  title: string | null;
  durationMin: number | null;
  transcriptStatus: string | null;
  transcriptUnavailableReason: string | null;
  revAiState: string | null;
  hasTranscript: boolean;
  clientId: string | null;
  clientName: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  participants: Array<{ name?: string; email?: string }>;
  aiSummary: string | null;
  analysis: {
    status: "pending" | "analyzed" | "failed";
    guessedClientId: string | null;
    guessedClientName: string | null;
    confidence: number | null;
    rationale: string | null;
    summary: string | null;
    summarySource: string | null;
    names: string[];
    model: string | null;
    error: string | null;
    analyzedAt: string | null;
  } | null;
};

type ClientOption = { id: string; firmName: string };

async function fetchJson(url: string) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Searchable client picker (pattern copied from ZoomReviewQueue's local
 * ClientPicker) with an explicit "leave unattributed" entry.
 */
function ClientPicker({
  clients,
  isLoading,
  value,
  onChange,
  testId,
}: {
  clients: ClientOption[];
  isLoading: boolean;
  value: string; // client id or UNATTRIBUTED
  onChange: (id: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = value !== UNATTRIBUTED ? clients.find((c) => c.id === value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          size="sm"
          className="w-56 justify-between font-normal"
          data-testid={testId}
        >
          <span className="truncate text-left">
            {selected
              ? selected.firmName
              : value === UNATTRIBUTED
                ? "— Unattributed —"
                : isLoading
                  ? "Loading clients…"
                  : "Pick a client…"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search clients…" />
          <CommandList>
            <CommandEmpty>
              {isLoading ? "Loading clients…" : "No client found."}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="— Unattributed —"
                onSelect={() => {
                  onChange(UNATTRIBUTED);
                  setOpen(false);
                }}
                data-testid={`${testId}-option-unattributed`}
              >
                <Check
                  className={`mr-2 h-4 w-4 ${value === UNATTRIBUTED ? "opacity-100" : "opacity-0"}`}
                />
                <span className="italic text-gray-500">— Unattributed —</span>
              </CommandItem>
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
      </PopoverContent>
    </Popover>
  );
}

function TranscriptBadge({ call }: { call: WorkbenchCall }) {
  if (call.hasTranscript) {
    return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-950/40" data-testid={`badge-transcript-${call.id}`}>
        Transcript
      </Badge>
    );
  }
  if (call.transcriptStatus === "unavailable") {
    return (
      <Badge
        className="bg-gray-100 text-muted-foreground hover:bg-gray-100"
        title={call.transcriptUnavailableReason || "No transcript could be obtained from Zoom"}
        data-testid={`badge-transcript-${call.id}`}
      >
        Unavailable
      </Badge>
    );
  }
  if (call.revAiState && !["failed", "given_up"].includes(call.revAiState)) {
    return (
      <Badge
        className="bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/40"
        title={`Rev AI transcription: ${call.revAiState}`}
        data-testid={`badge-transcript-${call.id}`}
      >
        Generating…
      </Badge>
    );
  }
  if (call.transcriptStatus === "failed") {
    return (
      <Badge className="bg-red-100 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/40" data-testid={`badge-transcript-${call.id}`}>
        Failed
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/40 whitespace-normal" data-testid={`badge-transcript-${call.id}`}>
      Pending
    </Badge>
  );
}

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null;
  const pct = Math.round(confidence * 100);
  const cls =
    confidence >= LOW_CONFIDENCE_THRESHOLD
      ? confidence >= 0.85
        ? "bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-950/40"
        : "bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/40 whitespace-normal"
      : "bg-red-100 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/40";
  return <Badge className={cls}>{pct}%</Badge>;
}

function monthOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < 12; i++) {
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({
      value: `${y}-${String(m + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
    });
    d.setMonth(m - 1);
  }
  return out;
}

const PHASE_LABELS: Record<string, string> = {
  discovery: "Scanning Zoom cloud recordings",
  transcripts: "Downloading missing transcripts",
  analysis: "Queueing AI analysis",
  done: "Sweep finished",
};

export default function ZoomMatchAssistant() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [assigned, setAssigned] = useState<"unassigned" | "all">("unassigned");
  const [month, setMonth] = useState<string>("all");
  const [confidence, setConfidence] = useState<"low" | "all">("all");
  const [page, setPage] = useState(1);
  const limit = 25;
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data: sweepData } = useQuery<{ sweep: SweepStatus | null }>({
    queryKey: ["/api/admin/zoom/match-assistant/sweep"],
    queryFn: () => fetchJson("/api/admin/zoom/match-assistant/sweep"),
    refetchInterval: (query) => {
      const s = query.state.data?.sweep;
      return s && (s.status === "running" || s.analysesPending > 0) ? 2500 : false;
    },
  });
  const sweep = sweepData?.sweep ?? null;
  const sweepActive = !!sweep && (sweep.status === "running" || sweep.analysesPending > 0);

  const callsUrl = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      assigned,
      confidence,
    });
    if (month !== "all") params.set("month", month);
    return `/api/admin/zoom/match-assistant/calls?${params.toString()}`;
  }, [page, limit, assigned, confidence, month]);

  const {
    data: callsData,
    isLoading: callsLoading,
    isError: callsError,
    refetch: refetchCalls,
  } = useQuery<{ calls: WorkbenchCall[]; total: number }>({
    queryKey: ["/api/admin/zoom/match-assistant/calls", { page, assigned, confidence, month }],
    queryFn: () => fetchJson(callsUrl),
    // While the sweep/analysis is landing results, keep the table fresh so
    // rows appear incrementally without a manual reload.
    refetchInterval: sweepActive ? 5000 : false,
  });

  const { data: clientsData, isLoading: clientsLoading } = useQuery<ClientOption[]>({
    queryKey: ["/api/clients"],
    queryFn: () => fetchJson("/api/clients"),
  });
  const clients = clientsData ?? [];

  const startSweep = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/zoom/match-assistant/sweep", {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Sweep started", description: "Walking the past 12 months of Zoom recordings…" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/match-assistant/sweep"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't start sweep",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/match-assistant/sweep"] });
    },
  });

  const assign = useMutation({
    mutationFn: async ({ recordId, clientId }: { recordId: string; clientId: string | null }) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/zoom/match-assistant/calls/${recordId}/assign`,
        { clientId },
      );
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Saved", description: data?.message || "Assignment updated" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/match-assistant/calls"] });
    },
    onError: (err: any) => {
      toast({
        title: "Assignment failed",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
    },
  });

  const reanalyze = useMutation({
    mutationFn: async (recordId: string) => {
      const res = await apiRequest(
        "POST",
        `/api/admin/zoom/match-assistant/calls/${recordId}/reanalyze`,
        {},
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Re-analysis queued", description: "The AI guess for this call will refresh shortly." });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/zoom/match-assistant/calls"] });
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't queue re-analysis",
        description: String(err?.message ?? err),
        variant: "destructive",
      });
    },
  });

  const calls = callsData?.calls ?? [];
  const total = callsData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const selectionFor = (call: WorkbenchCall): string =>
    selections[call.id] ??
    call.analysis?.guessedClientId ??
    call.clientId ??
    UNATTRIBUTED;

  const counters = sweep?.counters ?? {};

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-6">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="Transcript Match Assistant"
          icon={Wand2}
          backHref="/admin/zoom"
          backLabel="Zoom Integration"
          backTestId="button-back-zoom"
          titleTestId="text-match-assistant-title"
          subtitle="Sweep the past year of Zoom recordings, let AI guess the client for each still-unmatched call, then confirm assignments here."
          className="mb-6"
          actions={
            <Button
              onClick={() => startSweep.mutate()}
              disabled={startSweep.isPending || sweep?.status === "running"}
              data-testid="button-start-sweep"
            >
              {startSweep.isPending || sweep?.status === "running" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              {sweep?.status === "running" ? "Sweep running…" : "Sweep past year"}
            </Button>
          }
        />

        {sweep && (
          <Card className="mb-6" data-testid="card-sweep-progress">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg flex items-center gap-2">
                Sweep progress
                {sweep.status === "running" && !sweep.stalled && (
                  <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/40">
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    {PHASE_LABELS[sweep.phase] ?? sweep.phase}
                    {sweep.phase === "discovery" && sweep.windowsTotal > 0 && (
                      <> — window {Math.min(sweep.windowsDone + 1, sweep.windowsTotal)} of {sweep.windowsTotal}</>
                    )}
                  </Badge>
                )}
                {sweep.status === "running" && sweep.stalled && (
                  <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/40 whitespace-normal">
                    Stalled — no progress for 30+ minutes; starting a new sweep will supersede it
                  </Badge>
                )}
                {sweep.status === "completed" && sweep.analysesPending > 0 && (
                  <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-950/40">
                    <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                    Analyzing — {sweep.analysesPending} call{sweep.analysesPending === 1 ? "" : "s"} left
                  </Badge>
                )}
                {sweep.status === "completed" && sweep.analysesPending === 0 && (
                  <Badge className="bg-green-100 text-green-700 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-300 dark:hover:bg-green-950/40">Completed</Badge>
                )}
                {sweep.status === "failed" && (
                  <Badge className="bg-red-100 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/40">Failed</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sweep.lastError && (
                <div
                  className="mb-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 dark:text-red-300 dark:bg-red-950/30 dark:border-red-800 rounded-md p-2"
                  data-testid="text-sweep-error"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{sweep.lastError}</span>
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-2 text-sm" data-testid="grid-sweep-counters">
                {[
                  ["Windows walked", `${sweep.windowsDone}/${sweep.windowsTotal}`],
                  ["Meetings found", counters.meetingsFound ?? 0],
                  ["Newly ingested", counters.meetingsIngestEnqueued ?? 0],
                  ["Transcripts checked", counters.transcriptsChecked ?? 0],
                  ["Downloaded", counters.transcriptsDownloaded ?? 0],
                  ["Unavailable", counters.transcriptsUnavailable ?? 0],
                  ["Generating (Rev AI)", counters.transcriptsGenerating ?? 0],
                  ["Download failures", counters.transcriptsFailed ?? 0],
                  ["Queued for AI", counters.analysesEnqueued ?? 0],
                  ["Calls analyzed", counters.callsAnalyzed ?? 0],
                  ["Analysis failures", counters.analysesFailed ?? 0],
                  ["Analysis pending", sweep.analysesPending],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="text-gray-500">{label}</div>
                    <div className="font-semibold tabular-nums">{value}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-lg">
                Calls <span className="text-sm font-normal text-gray-500">({total})</span>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={assigned}
                  onValueChange={(v) => {
                    setAssigned(v as "unassigned" | "all");
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-44 h-9" data-testid="select-filter-assigned">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned only</SelectItem>
                    <SelectItem value="all">All calls</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={month}
                  onValueChange={(v) => {
                    setMonth(v);
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-40 h-9" data-testid="select-filter-month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All months</SelectItem>
                    {monthOptions().map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={confidence}
                  onValueChange={(v) => {
                    setConfidence(v as "low" | "all");
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-48 h-9" data-testid="select-filter-confidence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any confidence</SelectItem>
                    <SelectItem value="low">Low confidence (&lt;{Math.round(LOW_CONFIDENCE_THRESHOLD * 100)}%)</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={() => refetchCalls()} aria-label="Refresh calls" data-testid="button-refresh-calls">
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {callsLoading ? (
              <div className="flex items-center justify-center py-12 text-gray-500">
                <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading calls…
              </div>
            ) : callsError ? (
              <div className="flex items-center justify-center py-12 text-red-600" data-testid="text-calls-error">
                <AlertCircle className="w-5 h-5 mr-2" /> Couldn't load calls.
                <Button variant="outline" size="sm" className="ml-3" onClick={() => refetchCalls()}>
                  Retry
                </Button>
              </div>
            ) : calls.length === 0 ? (
              <div className="text-center py-12 text-gray-500" data-testid="text-no-calls">
                No calls match these filters.
                {!sweep && " Run a sweep to pull in the past year of Zoom recordings."}
              </div>
            ) : (
              <div className="space-y-3">
                {calls.map((call) => {
                  const isExpanded = expanded[call.id] ?? false;
                  const summary = call.analysis?.summary ?? call.aiSummary;
                  const names = call.analysis?.names ?? [];
                  const shownNames = isExpanded ? names : names.slice(0, 6);
                  const sel = selectionFor(call);
                  const selChanged =
                    (sel === UNATTRIBUTED ? null : sel) !== (call.clientId ?? null);
                  return (
                    <div
                      key={call.id}
                      className="border rounded-lg p-4"
                      data-testid={`row-call-${call.id}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={() =>
                                setExpanded((e) => ({ ...e, [call.id]: !isExpanded }))
                              }
                              data-testid={`button-expand-${call.id}`}
                              aria-label={isExpanded ? "Collapse" : "Expand"}
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </button>
                            <span className="font-medium truncate" data-testid={`text-title-${call.id}`}>
                              {call.title || "Untitled meeting"}
                            </span>
                            <span className="text-sm text-muted-foreground whitespace-nowrap">
                              {new Date(call.timestamp).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              })}
                              {call.durationMin ? ` · ${call.durationMin} min` : ""}
                            </span>
                            <TranscriptBadge call={call} />
                            {call.clientId && (
                              <Badge
                                className="bg-indigo-100 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                                data-testid={`badge-current-client-${call.id}`}
                              >
                                {call.clientName || "Assigned"}
                              </Badge>
                            )}
                          </div>

                          <div className="mt-2 text-sm text-foreground">
                            {call.analysis?.status === "analyzed" ? (
                              <>
                                <div className={isExpanded ? "" : "line-clamp-2"} data-testid={`text-summary-${call.id}`}>
                                  {summary || <span className="text-muted-foreground">No summary produced.</span>}
                                </div>
                                {isExpanded && call.analysis.rationale && (
                                  <div className="mt-2 text-xs text-muted-foreground" data-testid={`text-rationale-${call.id}`}>
                                    <span className="font-medium">Why this guess:</span>{" "}
                                    {call.analysis.rationale}
                                  </div>
                                )}
                              </>
                            ) : call.analysis?.status === "pending" ? (
                              <span className="inline-flex items-center text-blue-700">
                                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Analyzing…
                              </span>
                            ) : call.analysis?.status === "failed" ? (
                              <span
                                className="inline-flex items-center text-red-600"
                                title={call.analysis.error || undefined}
                                data-testid={`text-analysis-failed-${call.id}`}
                              >
                                <AlertCircle className="w-3.5 h-3.5 mr-1.5" /> AI analysis failed
                                {call.analysis.error ? ` — ${call.analysis.error.slice(0, 120)}` : ""}
                              </span>
                            ) : summary ? (
                              <div className={isExpanded ? "" : "line-clamp-2"} data-testid={`text-summary-${call.id}`}>
                                {summary}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">
                                {call.hasTranscript
                                  ? "Not analyzed yet."
                                  : "No transcript — nothing to analyze."}
                              </span>
                            )}
                          </div>

                          {names.length > 0 && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid={`chips-names-${call.id}`}>
                              <Users className="w-3.5 h-3.5 text-gray-400" />
                              {shownNames.map((n) => (
                                <span
                                  key={n}
                                  className="inline-block rounded-full bg-gray-100 text-gray-700 text-xs px-2 py-0.5"
                                >
                                  {n}
                                </span>
                              ))}
                              {!isExpanded && names.length > shownNames.length && (
                                <button
                                  className="text-xs text-muted-foreground underline"
                                  onClick={() => setExpanded((e) => ({ ...e, [call.id]: true }))}
                                >
                                  +{names.length - shownNames.length} more
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col items-end gap-2 shrink-0">
                          {call.analysis?.status === "analyzed" && (
                            <div className="flex items-center gap-2 text-sm" data-testid={`text-guess-${call.id}`}>
                              <span className="text-gray-500">AI guess:</span>
                              <span className="font-medium">
                                {call.analysis.guessedClientName ?? "Unattributed"}
                              </span>
                              <ConfidenceBadge confidence={call.analysis.confidence} />
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <ClientPicker
                              clients={clients}
                              isLoading={clientsLoading}
                              value={sel}
                              onChange={(id) =>
                                setSelections((s) => ({ ...s, [call.id]: id }))
                              }
                              testId={`picker-client-${call.id}`}
                            />
                            <Button
                              size="sm"
                              disabled={
                                assign.isPending || (!selChanged && call.analysis?.status !== "analyzed")
                              }
                              onClick={() =>
                                assign.mutate({
                                  recordId: call.id,
                                  clientId: sel === UNATTRIBUTED ? null : sel,
                                })
                              }
                              data-testid={`button-assign-${call.id}`}
                            >
                              {assign.isPending && assign.variables?.recordId === call.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Check className="w-4 h-4 mr-1" />
                              )}
                              Assign
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!call.hasTranscript || reanalyze.isPending}
                              title={
                                call.hasTranscript
                                  ? "Force a fresh AI guess for this call"
                                  : "No transcript to analyze"
                              }
                              onClick={() => reanalyze.mutate(call.id)}
                              data-testid={`button-reanalyze-${call.id}`}
                            >
                              <RefreshCw className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
                <span data-testid="text-pagination">
                  Page {page} of {totalPages} · {total} calls
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    data-testid="button-prev-page"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                    data-testid="button-next-page"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
