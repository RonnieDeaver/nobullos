/**
 * Task #3712 — Churn Command Center: "Team Coaching" tab.
 *
 * Two sub-views for the director:
 *
 *   Trends — per-account-manager churn trends built from data the pipeline
 *   already writes (daily judgments, communication insights, raw comms):
 *   book size, health-status mix, average risk with 7/30-day deltas, top
 *   complaint themes and 30-day comms volume — each AM side by side with
 *   the department rollup, plus an "Unassigned" bucket for ownerless books.
 *
 *   Coaching — "Generate coaching reports" kicks a background run that
 *   analyzes each AM's actual Zoom transcripts and outbound emails.
 *   Progress polls while running ("N of M analyzed"); a second start gets
 *   a graceful conflict toast. Past runs stay selectable so patterns can
 *   be compared against earlier runs. Every mistake carries verbatim
 *   evidence excerpts that open the underlying call/email; material where
 *   the staff member couldn't be verified is shown as "unattributed",
 *   never pinned on the book owner.
 *
 * Reads the director-gated /api/churn/team-trends + /api/churn/coaching/*
 * routes. Sub-view (and optional runId) sync to ?view= / ?runId= so the
 * completion notification can deep-link straight to a finished run.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { StatusPill, type StatusTone } from "@/components/kit/StatusPill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  GraduationCap,
  Loader2,
  Mail,
  Minus,
  Quote,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Video,
} from "lucide-react";
import type {
  AmCoachingDepartmentSynthesis,
  AmCoachingEvidence,
  AmCoachingMistake,
  AmCoachingStrength,
  AmCoachingUnattributedObservation,
} from "@shared/schema";

// ── API types (mirror server/routes/churn.ts responses) ────────────────────

interface TeamTrendTheme {
  category: string;
  mentions: number;
  clientCount: number;
  weight: number;
}

interface TeamTrendStatusMix {
  healthy: number;
  watch: number;
  atRisk: number;
  critical: number;
  noData: number;
}

interface TeamTrendBucket {
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerAvatar: string | null;
  unassigned: boolean;
  clientCount: number;
  statusMix: TeamTrendStatusMix;
  avgRisk: number | null;
  scoredClients: number;
  riskDelta7d: number | null;
  riskDelta30d: number | null;
  comms: { total: number; zoom: number; email: number };
  topThemes: TeamTrendTheme[];
}

interface TeamTrendsResponse {
  managers: TeamTrendBucket[];
  department: Omit<
    TeamTrendBucket,
    "ownerId" | "ownerName" | "ownerEmail" | "ownerAvatar" | "unassigned"
  > & { managerCount: number };
  generatedAt: string;
}

interface CoachingRun {
  id: string;
  status: "running" | "completed" | "failed";
  requestedByUserId: string | null;
  requestedByName?: string | null;
  totalManagers: number;
  processedManagers: number;
  failedManagers: number;
  departmentSynthesisJson: AmCoachingDepartmentSynthesis | null;
  modelVersion: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface CoachingReport {
  id: string;
  amUserId: string;
  amName: string;
  amEmail: string | null;
  amAvatar: string | null;
  status: "completed" | "insufficient_data" | "failed";
  clientCount: number;
  zoomSampleCount: number;
  emailSampleCount: number;
  unattributedSampleCount: number;
  mistakes: AmCoachingMistake[];
  unattributed: AmCoachingUnattributedObservation[];
  strengths: AmCoachingStrength[];
  zoomSummary: string | null;
  emailSummary: string | null;
  coachingFocus: string | null;
  insufficientData: boolean;
  error: string | null;
}

interface RunsResponse {
  runs: CoachingRun[];
  generatedAt: string;
}

interface RunDetailResponse {
  run: CoachingRun;
  reports: CoachingReport[];
  generatedAt: string;
}

interface CommRecordDetail {
  id: string;
  title: string;
  contentText: string | null;
  timestamp: string;
  sourceType: string;
}

// ── Small display helpers ───────────────────────────────────────────────────

function riskColor(risk: number | null): string {
  if (risk === null) return "text-muted-foreground";
  if (risk >= 70) return "text-status-critical";
  if (risk >= 40) return "text-status-warn";
  return "text-foreground";
}

function DeltaBadge({ delta, testId }: { delta: number | null; testId?: string }) {
  if (delta === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground" data-testid={testId}>
        <Minus className="w-3 h-3" />—
      </span>
    );
  }
  const worsening = delta > 0;
  const flat = delta === 0;
  const Icon = flat ? Minus : worsening ? TrendingUp : TrendingDown;
  const color = flat ? "text-muted-foreground" : worsening ? "text-status-critical" : "text-status-ok";
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${color}`} data-testid={testId}>
      <Icon className="w-3 h-3" />
      {worsening ? "+" : ""}
      {delta.toFixed(1)}
    </span>
  );
}

function StatusMixCell({ mix }: { mix: TeamTrendStatusMix }) {
  const parts: Array<{ label: string; count: number; tone: StatusTone }> = [
    { label: "Healthy", count: mix.healthy, tone: "neutral" },
    { label: "Watch", count: mix.watch, tone: "neutral" },
    { label: "At Risk", count: mix.atRisk, tone: "warn" },
    { label: "Critical", count: mix.critical, tone: "critical" },
    { label: "No data", count: mix.noData, tone: "neutral" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {parts
        .filter((p) => p.count > 0)
        .map((p) => (
          <StatusPill key={p.label} tone={p.tone} title={p.label}>
            {p.count} {p.label}
          </StatusPill>
        ))}
    </div>
  );
}

function ThemeChips({ themes, max = 3 }: { themes: TeamTrendTheme[]; max?: number }) {
  if (themes.length === 0) {
    return <span className="text-xs text-muted-foreground">None recorded</span>;
  }
  const shown = themes.slice(0, max);
  const extra = themes.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <span
          key={t.category}
          className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-caption"
          title={`${t.mentions} mention${t.mentions === 1 ? "" : "s"} across ${t.clientCount} client${t.clientCount === 1 ? "" : "s"}`}
        >
          {t.category} ×{t.mentions}
        </span>
      ))}
      {extra > 0 && <span className="text-caption text-muted-foreground">+{extra} more</span>}
    </div>
  );
}

/** S5 = act-now, S4 = attention soon; everything below rests neutral. */
function severityTone(severity: number): StatusTone {
  if (severity >= 5) return "critical";
  if (severity >= 4) return "warn";
  return "neutral";
}

function ChannelIcon({ channel }: { channel: string }) {
  if (channel === "zoom") return <Video className="w-3.5 h-3.5 text-muted-foreground" />;
  if (channel === "email") return <Mail className="w-3.5 h-3.5 text-muted-foreground" />;
  return (
    <span className="inline-flex gap-0.5">
      <Video className="w-3.5 h-3.5 text-muted-foreground" />
      <Mail className="w-3.5 h-3.5 text-muted-foreground" />
    </span>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatRunLabel(run: CoachingRun): string {
  const when = new Date(run.startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const state =
    run.status === "running"
      ? `running · ${run.processedManagers}/${run.totalManagers}`
      : run.status === "failed"
        ? "failed"
        : `${run.totalManagers} AMs`;
  return `${when} — ${state}`;
}

// ── Evidence dialog ─────────────────────────────────────────────────────────

function EvidenceDialog({
  evidence,
  onClose,
}: {
  evidence: AmCoachingEvidence | null;
  onClose: () => void;
}) {
  const { data: record, isLoading } = useQuery<CommRecordDetail>({
    queryKey: ["/api/clients", evidence?.clientId, "communications", evidence?.recordId],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/clients/${evidence!.clientId}/communications/${evidence!.recordId}`,
      );
      return res.json();
    },
    enabled: !!evidence?.clientId && !!evidence?.recordId,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Dialog open={!!evidence} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="dialog-coaching-evidence">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {evidence?.sourceType === "zoom" ? (
              <Video className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Mail className="w-4 h-4 text-muted-foreground" />
            )}
            <span className="truncate">{evidence?.title}</span>
          </DialogTitle>
          <DialogDescription>
            {evidence?.clientName ?? "Unknown client"} ·{" "}
            {evidence ? new Date(evidence.timestamp).toLocaleString() : ""}
            {evidence && !evidence.attributed && (
              <span className="ml-2 text-status-warn font-medium">
                Staff member unverified
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {evidence && (
          <div className="space-y-3">
            <blockquote className="border-l-2 border-primary pl-3 text-sm italic text-foreground bg-surface-warm-2 py-2">
              <Quote className="w-3 h-3 inline mr-1 text-primary" />
              {evidence.excerpt}
            </blockquote>

            <div className="border">
              <div className="px-3 py-1.5 border-b bg-muted/50 text-caption font-medium text-muted-foreground uppercase tracking-wide">
                Full {evidence.sourceType === "zoom" ? "transcript" : "email"}
              </div>
              <ScrollArea className="h-64">
                <pre className="p-3 text-xs whitespace-pre-wrap font-sans text-foreground/90">
                  {isLoading
                    ? "Loading…"
                    : (record?.contentText ?? "Content unavailable.")}
                </pre>
              </ScrollArea>
            </div>

            {evidence.clientId && (
              <Button asChild variant="outline" size="sm" data-testid="link-evidence-client">
                <Link href={`/clients/${evidence.clientId}`}>
                  <ExternalLink className="w-3.5 h-3.5 mr-1" />
                  Open client page
                </Link>
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Per-AM report card ──────────────────────────────────────────────────────

function ReportCard({
  report,
  onOpenEvidence,
}: {
  report: CoachingReport;
  onOpenEvidence: (e: AmCoachingEvidence) => void;
}) {
  const [open, setOpen] = useState(false);

  const statusBadge =
    report.status === "completed" ? (
      <StatusPill>Coached</StatusPill>
    ) : report.status === "insufficient_data" ? (
      <StatusPill>Insufficient data</StatusPill>
    ) : (
      <StatusPill tone="critical">Failed</StatusPill>
    );

  return (
    <Card data-testid={`card-am-report-${report.amUserId}`}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full text-left"
            data-testid={`button-expand-report-${report.amUserId}`}
          >
            <CardHeader className="py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar className="w-8 h-8">
                  <AvatarImage src={report.amAvatar ?? undefined} />
                  <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                    {initials(report.amName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{report.amName}</span>
                    {statusBadge}
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {report.clientCount} client{report.clientCount === 1 ? "" : "s"} ·{" "}
                    {report.zoomSampleCount} call{report.zoomSampleCount === 1 ? "" : "s"} +{" "}
                    {report.emailSampleCount} email{report.emailSampleCount === 1 ? "" : "s"} analyzed
                    {report.unattributedSampleCount > 0 &&
                      ` · ${report.unattributedSampleCount} unattributed`}
                  </p>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                />
              </div>
              {report.status === "completed" && report.coachingFocus && (
                <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1.5">
                  <GraduationCap className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
                  <span className="line-clamp-2">{report.coachingFocus}</span>
                </p>
              )}
              {report.status === "insufficient_data" && (
                <p className="text-xs text-muted-foreground mt-2">
                  Not enough Zoom calls or emails where {report.amName.split(" ")[0]} could be
                  verified as the participant/author. No coaching was fabricated.
                </p>
              )}
              {report.status === "failed" && report.error && (
                <p className="text-xs text-status-critical mt-2 line-clamp-2">{report.error}</p>
              )}
            </CardHeader>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          {report.status === "completed" && (
            <CardContent className="pt-0 pb-4 space-y-4">
              {report.mistakes.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Biggest recurring mistakes
                  </h4>
                  <div className="space-y-3">
                    {report.mistakes.map((m, i) => (
                      <div
                        key={i}
                        className="border p-3"
                        data-testid={`mistake-${report.amUserId}-${i}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <StatusPill tone={severityTone(m.severity)} className="font-semibold">
                            S{m.severity}
                          </StatusPill>
                          <ChannelIcon channel={m.channel} />
                          <span className="font-medium text-sm">{m.title}</span>
                        </div>
                        <p className="text-body text-muted-foreground mt-1.5 max-w-prose">{m.description}</p>
                        {m.evidence.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {m.evidence.map((e, j) => (
                              <button
                                key={j}
                                type="button"
                                onClick={() => onOpenEvidence(e)}
                                className="w-full text-left border-l-2 border-border hover:border-primary pl-2 py-1 group"
                                data-testid={`button-evidence-${report.amUserId}-${i}-${j}`}
                              >
                                <p className="text-caption italic text-muted-foreground group-hover:text-foreground line-clamp-2">
                                  “{e.excerpt}”
                                </p>
                                <p className="text-caption text-muted-foreground mt-0.5">
                                  {e.sourceType === "zoom" ? "Zoom call" : "Email"} ·{" "}
                                  {e.clientName ?? "Unknown client"} ·{" "}
                                  {new Date(e.timestamp).toLocaleDateString()} — view
                                </p>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(report.zoomSummary || report.emailSummary) && (
                <section className="grid sm:grid-cols-2 gap-3">
                  {report.zoomSummary && (
                    <div className="bg-surface-warm-2 p-3">
                      <h5 className="text-caption font-semibold text-muted-foreground flex items-center gap-1 mb-1">
                        <Video className="w-3 h-3" /> On Zoom calls
                      </h5>
                      <p className="text-body text-muted-foreground max-w-prose">{report.zoomSummary}</p>
                    </div>
                  )}
                  {report.emailSummary && (
                    <div className="bg-surface-warm-2 p-3">
                      <h5 className="text-caption font-semibold text-muted-foreground flex items-center gap-1 mb-1">
                        <Mail className="w-3 h-3" /> In emails
                      </h5>
                      <p className="text-body text-muted-foreground max-w-prose">{report.emailSummary}</p>
                    </div>
                  )}
                </section>
              )}

              {report.strengths.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Strengths
                  </h4>
                  <div className="space-y-1.5">
                    {report.strengths.map((s, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                        <p className="text-body text-muted-foreground max-w-prose">
                          <span className="font-medium text-foreground">{s.title}.</span>{" "}
                          {s.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {report.coachingFocus && (
                <section className="bg-surface-warm-2 border p-3">
                  <h4 className="text-caption font-semibold text-foreground flex items-center gap-1 mb-1">
                    <GraduationCap className="w-3.5 h-3.5" /> Suggested coaching focus
                  </h4>
                  <p className="text-body text-foreground max-w-prose">{report.coachingFocus}</p>
                </section>
              )}

              {report.unattributed.length > 0 && (
                <section>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                    Unattributed observations
                  </h4>
                  <p className="text-caption text-muted-foreground mb-2">
                    Issues seen in this book where the staff member couldn't be verified —
                    not pinned on {report.amName.split(" ")[0]}.
                  </p>
                  <div className="space-y-2">
                    {report.unattributed.map((u, i) => (
                      <div key={i} className="border border-dashed p-2.5">
                        <p className="text-xs font-medium text-muted-foreground">{u.title}</p>
                        <p className="text-body text-muted-foreground mt-0.5 max-w-prose">{u.description}</p>
                        {u.evidence.map((e, j) => (
                          <button
                            key={j}
                            type="button"
                            onClick={() => onOpenEvidence(e)}
                            className="block text-left text-caption text-muted-foreground hover:text-muted-foreground mt-1"
                            data-testid={`button-unattributed-evidence-${report.amUserId}-${i}-${j}`}
                          >
                            “{e.excerpt.slice(0, 120)}
                            {e.excerpt.length > 120 ? "…" : ""}” — view
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </CardContent>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// ── Main tab ────────────────────────────────────────────────────────────────

export function TeamCoachingTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const search = useSearch();
  const [, navigate] = useLocation();

  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const view: "trends" | "coaching" = params.get("view") === "coaching" ? "coaching" : "trends";
  const urlRunId = params.get("runId");

  const [selectedRunId, setSelectedRunId] = useState<string | null>(urlRunId);
  const [evidence, setEvidence] = useState<AmCoachingEvidence | null>(null);

  const setView = (next: "trends" | "coaching") => {
    const p = new URLSearchParams(search);
    p.set("tab", "team-coaching");
    p.set("view", next);
    navigate(`/churn?${p.toString()}`, { replace: false });
  };

  // ── Trends ──
  const trendsQuery = useQuery<TeamTrendsResponse>({
    queryKey: ["/api/churn/team-trends"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/churn/team-trends");
      return res.json();
    },
  });

  // ── Runs ──
  const runsQuery = useQuery<RunsResponse>({
    queryKey: ["/api/churn/coaching/runs"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/churn/coaching/runs");
      return res.json();
    },
    refetchInterval: (query) =>
      query.state.data?.runs?.some((r) => r.status === "running") ? 3000 : false,
  });
  // Memoized: `?? []` minted a fresh array every render, which made the
  // default-selection effect below re-fire each render (exhaustive-deps).
  const runs = useMemo(() => runsQuery.data?.runs ?? [], [runsQuery.data?.runs]);
  const activeRun = runs.find((r) => r.status === "running") ?? null;

  // Default selection: URL runId (deep link) → active run → newest run.
  useEffect(() => {
    if (selectedRunId && runs.some((r) => r.id === selectedRunId)) return;
    const fallback = activeRun?.id ?? runs[0]?.id ?? null;
    if (fallback && fallback !== selectedRunId) setSelectedRunId(fallback);
  }, [runs, activeRun, selectedRunId]);

  const runDetailQuery = useQuery<RunDetailResponse>({
    queryKey: ["/api/churn/coaching/runs", selectedRunId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/churn/coaching/runs/${selectedRunId}`);
      return res.json();
    },
    enabled: !!selectedRunId,
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 2500 : false,
  });
  const runDetail = runDetailQuery.data;

  // When the selected run finishes, refresh the history list once more.
  useEffect(() => {
    if (runDetail?.run && runDetail.run.status !== "running") {
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/coaching/runs"] }); // fire-and-forget: cache refresh only
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runDetail?.run?.status]);

  const startRun = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/churn/coaching/runs");
      return res.json() as Promise<{ run: CoachingRun }>;
    },
    onSuccess: (data) => {
      setSelectedRunId(data.run.id);
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/coaching/runs"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      const message = String(err?.message ?? err);
      if (message.includes("409")) {
        toast({
          title: "A coaching run is already in progress",
          description: "Wait for it to finish — progress is shown on this tab.",
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/churn/coaching/runs"] }); // fire-and-forget: cache refresh only
      } else {
        toast({
          title: "Couldn't start the coaching run",
          description: message,
          variant: "destructive",
        });
      }
    },
  });

  const synthesis = runDetail?.run?.departmentSynthesisJson ?? null;
  const reportNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runDetail?.reports ?? []) map.set(r.amUserId, r.amName);
    return map;
  }, [runDetail?.reports]);

  const trends = trendsQuery.data;

  return (
    <div className="space-y-4">
      {/* Sub-view toggle + actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex border bg-card p-0.5">
          <Button
            variant={view === "trends" ? "default" : "ghost"}
            size="sm"
            className={view === "trends" ? "bg-primary hover:bg-primary/90" : ""}
            onClick={() => setView("trends")}
            data-testid="button-view-trends"
          >
            Trends
          </Button>
          <Button
            variant={view === "coaching" ? "default" : "ghost"}
            size="sm"
            className={view === "coaching" ? "bg-primary hover:bg-primary/90" : ""}
            onClick={() => setView("coaching")}
            data-testid="button-view-coaching"
          >
            Coaching reports
          </Button>
        </div>

        {view === "coaching" && (
          <div className="flex items-center gap-2 flex-wrap">
            {runs.length > 0 && (
              <Select
                value={selectedRunId ?? undefined}
                onValueChange={(v) => setSelectedRunId(v)}
              >
                <SelectTrigger
                  className="w-[240px] h-9 text-xs"
                  data-testid="select-coaching-run"
                >
                  <SelectValue placeholder="Select a run" />
                </SelectTrigger>
                <SelectContent>
                  {runs.map((r) => (
                    <SelectItem key={r.id} value={r.id} className="text-xs">
                      {formatRunLabel(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90"
              disabled={startRun.isPending || !!activeRun}
              onClick={() => startRun.mutate()}
              data-testid="button-generate-coaching"
            >
              {startRun.isPending || activeRun ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 mr-1.5" />
              )}
              {activeRun ? "Run in progress…" : "Generate coaching reports"}
            </Button>
          </div>
        )}
      </div>

      {view === "trends" ? (
        // ── TRENDS VIEW ──
        trendsQuery.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading team trends…
          </div>
        ) : trendsQuery.isError || !trends ? (
          <Card>
            <CardContent className="py-10 text-center space-y-3">
              <p className="text-sm text-muted-foreground">Couldn't load team trends.</p>
              <Button variant="outline" size="sm" onClick={() => trendsQuery.refetch()}>
                <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {/* Department rollup */}
            <Card data-testid="card-department-rollup">
              <CardHeader className="py-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" />
                  Department — {trends.department.managerCount} account manager
                  {trends.department.managerCount === 1 ? "" : "s"},{" "}
                  {trends.department.clientCount} active client
                  {trends.department.clientCount === 1 ? "" : "s"}
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <p className="text-caption text-muted-foreground uppercase tracking-wide">Avg risk</p>
                    <p className={`text-lg font-semibold ${riskColor(trends.department.avgRisk)}`}>
                      {trends.department.avgRisk ?? "—"}
                    </p>
                    <div className="flex gap-2 mt-0.5">
                      <DeltaBadge delta={trends.department.riskDelta7d} testId="delta-dept-7d" />
                      <span className="text-caption text-muted-foreground">7d</span>
                      <DeltaBadge delta={trends.department.riskDelta30d} testId="delta-dept-30d" />
                      <span className="text-caption text-muted-foreground">30d</span>
                    </div>
                  </div>
                  <div>
                    <p className="text-caption text-muted-foreground uppercase tracking-wide">Status mix</p>
                    <div className="mt-1">
                      <StatusMixCell mix={trends.department.statusMix} />
                    </div>
                  </div>
                  <div>
                    <p className="text-caption text-muted-foreground uppercase tracking-wide">
                      Comms · 30d
                    </p>
                    <p className="text-lg font-semibold text-foreground">
                      {trends.department.comms.total}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {trends.department.comms.zoom} Zoom · {trends.department.comms.email} email
                    </p>
                  </div>
                  <div>
                    <p className="text-caption text-muted-foreground uppercase tracking-wide">
                      Top complaint themes
                    </p>
                    <div className="mt-1">
                      <ThemeChips themes={trends.department.topThemes} />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Per-AM table */}
            <Card>
              <CardContent className="p-0">
                <Table data-testid="table-am-trends">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account manager</TableHead>
                      <TableHead className="text-right">Clients</TableHead>
                      <TableHead>Status mix</TableHead>
                      <TableHead className="text-right">Avg risk</TableHead>
                      <TableHead className="text-right">Δ 7d</TableHead>
                      <TableHead className="text-right">Δ 30d</TableHead>
                      <TableHead className="text-right">Comms 30d</TableHead>
                      <TableHead>Top complaint themes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trends.managers.map((m) => (
                      <TableRow
                        key={m.ownerId ?? "unassigned"}
                        className={m.unassigned ? "bg-status-warn/5" : undefined}
                        data-testid={`row-am-${m.ownerId ?? "unassigned"}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {m.unassigned ? (
                              <AlertTriangle className="w-4 h-4 text-status-warn" />
                            ) : (
                              <Avatar className="w-6 h-6">
                                <AvatarImage src={m.ownerAvatar ?? undefined} />
                                <AvatarFallback className="text-[11px] bg-primary text-primary-foreground">
                                  {initials(m.ownerName ?? "?")}
                                </AvatarFallback>
                              </Avatar>
                            )}
                            <span
                              className={`text-sm ${m.unassigned ? "italic text-status-warn" : "font-medium"}`}
                            >
                              {m.ownerName ?? "Unassigned"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right text-sm">{m.clientCount}</TableCell>
                        <TableCell>
                          <StatusMixCell mix={m.statusMix} />
                        </TableCell>
                        <TableCell
                          className={`text-right text-sm font-semibold ${riskColor(m.avgRisk)}`}
                        >
                          {m.avgRisk ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={m.riskDelta7d} />
                        </TableCell>
                        <TableCell className="text-right">
                          <DeltaBadge delta={m.riskDelta30d} />
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {m.comms.total}
                          <span className="text-caption text-muted-foreground ml-1">
                            ({m.comms.zoom}Z/{m.comms.email}E)
                          </span>
                        </TableCell>
                        <TableCell>
                          <ThemeChips themes={m.topThemes} />
                        </TableCell>
                      </TableRow>
                    ))}
                    {trends.managers.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">
                          No active clients yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        )
      ) : (
        // ── COACHING VIEW ──
        <div className="space-y-4">
          {/* Active-run progress */}
          {runDetail?.run?.status === "running" && (
            <Card data-testid="card-run-progress">
              <CardContent className="py-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    Analyzing account managers…
                  </span>
                  <span className="text-muted-foreground" data-testid="text-run-progress">
                    {runDetail.run.processedManagers} of {runDetail.run.totalManagers} analyzed
                    {runDetail.run.failedManagers > 0 &&
                      ` · ${runDetail.run.failedManagers} failed`}
                  </span>
                </div>
                <Progress
                  value={
                    runDetail.run.totalManagers > 0
                      ? (runDetail.run.processedManagers / runDetail.run.totalManagers) * 100
                      : 5
                  }
                />
                <p className="text-caption text-muted-foreground">
                  Reviewing each AM's recent Zoom transcripts and outbound emails. You'll get a
                  notification when the reports are ready.
                </p>
              </CardContent>
            </Card>
          )}

          {runs.length === 0 && !runsQuery.isLoading ? (
            <Card>
              <CardContent className="py-12 text-center space-y-3">
                <GraduationCap className="w-8 h-8 text-gray-300 mx-auto" />
                <p className="text-sm text-muted-foreground">
                  No coaching runs yet. Generate the first one to see each AM's biggest
                  recurring mistakes — grounded in their actual calls and emails.
                </p>
                <Button
                  className="bg-primary hover:bg-primary/90"
                  size="sm"
                  disabled={startRun.isPending}
                  onClick={() => startRun.mutate()}
                  data-testid="button-generate-coaching-empty"
                >
                  <Sparkles className="w-4 h-4 mr-1.5" /> Generate coaching reports
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Run meta / failure */}
              {runDetail?.run?.status === "failed" && (
                <Card className="border-status-critical/40">
                  <CardContent className="py-3 text-sm text-status-critical flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    This run failed: {runDetail.run.error ?? "unknown error"}
                  </CardContent>
                </Card>
              )}
              {runDetail?.run?.status === "completed" && runDetail.run.error && (
                <Card className="border-status-warn/40">
                  <CardContent className="py-3 text-xs text-status-warn flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    {runDetail.run.error}
                  </CardContent>
                </Card>
              )}

              {/* Department synthesis */}
              {synthesis && (
                <Card data-testid="card-department-synthesis">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Users className="w-4 h-4 text-primary" />
                      Department-wide patterns
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pb-4 space-y-3">
                    {synthesis.summary && (
                      <p className="text-body text-muted-foreground max-w-prose">{synthesis.summary}</p>
                    )}
                    <div className="space-y-2">
                      {synthesis.commonMistakes.map((cm, i) => (
                        <div
                          key={i}
                          className="border p-3"
                          data-testid={`common-mistake-${i}`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <StatusPill tone={severityTone(cm.severity)} className="font-semibold">
                              S{cm.severity}
                            </StatusPill>
                            <span className="font-medium text-sm">{cm.title}</span>
                          </div>
                          <p className="text-body text-muted-foreground mt-1 max-w-prose">{cm.description}</p>
                          <div className="flex flex-wrap gap-1 mt-2">
                            {cm.amUserIds.map((id) => (
                              <span
                                key={id}
                                className="px-1.5 py-0.5 rounded-pill bg-muted text-muted-foreground text-caption"
                              >
                                {reportNameById.get(id) ?? "Unknown AM"}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                      {synthesis.commonMistakes.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No patterns shared across multiple AMs in this run.
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Per-AM reports */}
              {runDetailQuery.isLoading && selectedRunId ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading reports…
                </div>
              ) : (
                <div className="space-y-3">
                  {(runDetail?.reports ?? []).map((r) => (
                    <ReportCard key={r.id} report={r} onOpenEvidence={setEvidence} />
                  ))}
                  {runDetail && runDetail.reports.length === 0 && runDetail.run.status !== "running" && (
                    <p className="text-center text-sm text-muted-foreground py-6">
                      No reports were produced by this run.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <EvidenceDialog evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
