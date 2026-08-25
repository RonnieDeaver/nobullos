/**
 * Task #3692 — Churn Command Center: Risk Radar tab.
 *
 * On-demand portfolio churn sweep: "Run sweep" asks every active client's
 * agent for its top-5 churn reasons (server-side background run with a
 * cross-instance lock — a re-press while running gets a 409 and a toast).
 * While a run is active the tab polls run progress ("N of M analyzed").
 *
 * Results render two rank-ordered views:
 *   - By client: clients ordered by churn likelihood, each expandable to
 *     its top-5 reasons with severity, confidence and supporting evidence.
 *     Insufficient-data and errored clients are bucketed below, never
 *     given fabricated reasons.
 *   - By theme: deduplicated cross-client themes ordered by portfolio
 *     impact (severity-weighted + client count), each expandable to the
 *     affected clients.
 *
 * Past runs stay selectable (run-history dropdown; ?run= deep link from
 * the completion notification) so this month's sweep can be compared to
 * last month's. Full results export as CSV client-side.
 *
 * Reads /api/churn/radar/* (director-gated, strict — same gate as the
 * leaderboard).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusPill, type StatusTone } from "@/components/kit/StatusPill";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle, ChevronDown, ChevronRight, CircleSlash, Download,
  FileQuestion, Loader2, Radar, RefreshCw, Users,
} from "lucide-react";

// ── API types (mirror server/routes/churn.ts radar serialization) ──────────

interface RadarRun {
  id: string;
  status: "running" | "synthesizing" | "completed" | "failed" | string;
  requestedBy: string | null;
  requesterName: string | null;
  totalClients: number;
  processedClients: number;
  analyzedClients: number;
  insufficientClients: number;
  errorClients: number;
  errorSummary: string | null;
  modelVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface RadarFinding {
  rank: number;
  reason: string;
  severity: "high" | "medium" | "low" | string;
  confidence: number | null;
  evidence: string[];
  themeCategory: string;
  themeLabel: string;
}

interface RadarClient {
  clientId: string;
  firmName: string;
  status: "analyzed" | "insufficient_data" | "error" | string;
  churnLikelihood: number | null;
  likelihoodBand: string | null;
  summary: string | null;
  insufficiencyReason: string | null;
  errorMessage: string | null;
  findings: RadarFinding[];
}

interface RadarThemeClient {
  clientId: string;
  firmName: string;
  churnLikelihood: number | null;
  likelihoodBand: string | null;
  worstSeverity: string;
  reasons: string[];
}

interface RadarTheme {
  category: string;
  label: string;
  clientCount: number;
  highRiskClientCount: number;
  severityCounts: { high: number; medium: number; low: number };
  impactScore: number;
  affectedClients: RadarThemeClient[];
  representativeReasons: string[];
}

interface RadarResultsResponse {
  run: RadarRun;
  clients: RadarClient[];
  themes: RadarTheme[];
  generatedAt: string | null;
}

// ── Display config ──────────────────────────────────────────────────────────

const BAND_CONFIG: Record<string, { label: string; tone: StatusTone }> = {
  critical: { label: "Critical", tone: "critical" },
  high: { label: "High", tone: "warn" },
  moderate: { label: "Moderate", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

const SEVERITY_TONE: Record<string, StatusTone> = {
  high: "warn",
  medium: "neutral",
  low: "neutral",
};

const ACTIVE_STATUSES = new Set(["running", "synthesizing"]);

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── CSV export (client-side; per-finding rows, escaped per RFC 4180) ───────

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildRadarCsv(results: RadarResultsResponse): string {
  const header = [
    "Firm", "Client Status", "Churn Likelihood", "Likelihood Band", "Client Summary",
    "Reason Rank", "Reason", "Severity", "Confidence", "Theme", "Evidence", "Notes",
  ];
  const lines = [header.join(",")];
  for (const c of results.clients) {
    const base = [
      c.firmName,
      c.status,
      c.churnLikelihood ?? "",
      c.likelihoodBand ?? "",
      c.summary ?? "",
    ];
    if (c.findings.length === 0) {
      lines.push(
        [...base, "", "", "", "", "", "", c.insufficiencyReason ?? c.errorMessage ?? ""]
          .map(csvEscape)
          .join(","),
      );
    } else {
      for (const f of c.findings) {
        lines.push(
          [
            ...base,
            f.rank,
            f.reason,
            f.severity,
            f.confidence ?? "",
            f.themeLabel,
            f.evidence.join(" | "),
            "",
          ]
            .map(csvEscape)
            .join(","),
        );
      }
    }
  }
  return lines.join("\r\n");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Component ───────────────────────────────────────────────────────────────

export function ChurnRiskRadarTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const search = useSearch();
  const deepLinkRunId = useMemo(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return params.get("run");
  }, [search]);

  const [manualRunId, setManualRunId] = useState<string | null>(null);
  const [view, setView] = useState<"clients" | "themes">("clients");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Runs list. Polls while any run is active so the progress bar and the
  // "just finished" transition happen without a manual refresh.
  const runsQuery = useQuery<{ runs: RadarRun[] }>({
    queryKey: ["/api/churn/radar/runs"],
    staleTime: 10_000,
    refetchInterval: (query) =>
      (query.state.data?.runs ?? []).some((r) => ACTIVE_STATUSES.has(r.status)) ? 2500 : false,
  });
  const runs = runsQuery.data?.runs ?? [];
  const activeRun = runs.find((r) => ACTIVE_STATUSES.has(r.status)) ?? null;

  // Selected run: manual choice > ?run= deep link > active run > latest.
  const selectedRun =
    (manualRunId && runs.find((r) => r.id === manualRunId)) ||
    (!manualRunId && deepLinkRunId && runs.find((r) => r.id === deepLinkRunId)) ||
    activeRun ||
    runs[0] ||
    null;

  const resultsQuery = useQuery<RadarResultsResponse>({
    queryKey: ["/api/churn/radar/runs", selectedRun?.id ?? "none", "results"],
    enabled: !!selectedRun && selectedRun.status === "completed",
    staleTime: 5 * 60 * 1000,
  });
  const results = resultsQuery.data ?? null;

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/churn/radar/runs");
      return res.json() as Promise<{ run: RadarRun | null; resumed: boolean }>;
    },
    meta: { silent: true }, // 409 gets bespoke copy below, not the generic toast
    onSuccess: (data) => {
      toast({
        title: data.resumed ? "Sweep resumed" : "Sweep started",
        description: "Interviewing every active client's agent — this takes a few minutes.",
      });
      if (data.run) setManualRunId(data.run.id);
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/radar/runs"] }); // fire-and-forget: cache refresh only
    },
    onError: (error: Error) => {
      if (error.message.startsWith("409:")) {
        toast({
          title: "Sweep already running",
          description: "A churn radar sweep is in progress — watch its progress here instead.",
        });
        void queryClient.invalidateQueries({ queryKey: ["/api/churn/radar/runs"] }); // fire-and-forget: cache refresh only
      } else {
        toast({
          title: "Couldn't start sweep",
          description: "Something went wrong — please try again.",
          variant: "destructive",
        });
      }
    },
  });

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectRun = (id: string) => {
    setManualRunId(id);
    setExpanded(new Set());
  };

  const analyzedClients = results?.clients.filter((c) => c.status === "analyzed") ?? [];
  const insufficientClients = results?.clients.filter((c) => c.status === "insufficient_data") ?? [];
  const errorClients = results?.clients.filter((c) => c.status === "error") ?? [];

  return (
    <div className="space-y-4" data-testid="churn-risk-radar-tab">
      {/* ── Header row: run button + history selector + export ───────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            onClick={() => startMutation.mutate()}
            disabled={startMutation.isPending || !!activeRun}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
            data-testid="button-run-sweep"
          >
            {activeRun ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Radar className="w-4 h-4 mr-2" />
            )}
            {activeRun ? "Sweep running…" : "Run sweep"}
          </Button>
          {runs.length > 0 && (
            <Select value={selectedRun?.id ?? ""} onValueChange={selectRun}>
              <SelectTrigger className="w-[260px]" data-testid="select-radar-run">
                <SelectValue placeholder="Select a run" />
              </SelectTrigger>
              <SelectContent>
                {runs.map((r) => (
                  <SelectItem key={r.id} value={r.id} data-testid={`option-run-${r.id}`}>
                    {fmtDateTime(r.startedAt)} — {r.status}
                    {r.requesterName ? ` · ${r.requesterName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-2">
          {runsQuery.isFetching && !runsQuery.isLoading && (
            <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin" />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!results}
            onClick={() => {
              if (!results) return;
              const stamp = (results.run.startedAt ?? "").slice(0, 10) || "run";
              downloadCsv(`churn-risk-radar-${stamp}-${results.run.id.slice(0, 8)}.csv`, buildRadarCsv(results));
            }}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* ── Active run progress ───────────────────────────────────────────── */}
      {selectedRun && ACTIVE_STATUSES.has(selectedRun.status) && (
        <Card data-testid="card-sweep-progress">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-foreground flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                {selectedRun.status === "synthesizing"
                  ? "Synthesizing portfolio themes…"
                  : "Interviewing client agents…"}
              </span>
              <span className="text-gray-500" data-testid="text-sweep-progress">
                {selectedRun.processedClients} of {selectedRun.totalClients} clients analyzed
              </span>
            </div>
            <Progress
              value={
                selectedRun.totalClients > 0
                  ? (selectedRun.processedClients / selectedRun.totalClients) * 100
                  : 5
              }
            />
            <p className="text-caption text-gray-500">
              You'll get a notification when it finishes — it's safe to leave this page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── Failed run ────────────────────────────────────────────────────── */}
      {selectedRun?.status === "failed" && (
        <Card data-testid="card-sweep-failed">
          <CardContent className="p-4 flex items-start gap-2 text-sm text-status-critical">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">This sweep failed.</p>
              <p className="text-status-critical/80">{selectedRun.errorSummary ?? "Unknown error"}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!runsQuery.isLoading && runs.length === 0 && (
        <Card data-testid="card-radar-empty">
          <CardContent className="p-8 text-center text-sm text-gray-500">
            <Radar className="w-8 h-8 mx-auto mb-2 text-gray-300" />
            No sweeps yet. Run one to ask every client's agent where churn risk is coming from.
          </CardContent>
        </Card>
      )}

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {selectedRun?.status === "completed" && (
        <>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1" data-testid="toggle-radar-view">
              <Button
                size="sm"
                variant={view === "clients" ? "default" : "outline"}
                className={view === "clients" ? "bg-primary hover:bg-primary/90" : ""}
                onClick={() => setView("clients")}
                data-testid="button-view-clients"
              >
                <Users className="w-3.5 h-3.5 mr-1" />
                By client
              </Button>
              <Button
                size="sm"
                variant={view === "themes" ? "default" : "outline"}
                className={view === "themes" ? "bg-primary hover:bg-primary/90" : ""}
                onClick={() => setView("themes")}
                data-testid="button-view-themes"
              >
                By theme
              </Button>
            </div>
            <p className="text-xs text-gray-500" data-testid="text-run-summary">
              {selectedRun.analyzedClients} analyzed · {selectedRun.insufficientClients} insufficient data ·{" "}
              {selectedRun.errorClients} errors · finished {fmtDateTime(selectedRun.finishedAt)}
            </p>
          </div>

          {resultsQuery.isLoading && (
            <Card>
              <CardContent className="p-8 text-center text-sm text-gray-500">
                <Loader2 className="w-5 h-5 mx-auto animate-spin mb-2" />
                Loading results…
              </CardContent>
            </Card>
          )}

          {results && view === "clients" && (
            <div className="space-y-2" data-testid="list-radar-clients">
              {analyzedClients.map((c, idx) => {
                const band = BAND_CONFIG[c.likelihoodBand ?? ""] ?? null;
                const isOpen = expanded.has(c.clientId);
                return (
                  <Card key={c.clientId} data-testid={`card-radar-client-${c.clientId}`}>
                    <CardContent className="p-0">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(c.clientId)}
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50"
                        data-testid={`button-expand-client-${c.clientId}`}
                      >
                        <span className="text-xs font-semibold text-muted-foreground w-6 shrink-0">#{idx + 1}</span>
                        <span className="font-medium text-sm text-foreground flex-1 min-w-0 truncate">
                          {c.firmName}
                        </span>
                        {c.churnLikelihood !== null && (
                          <span className="text-sm font-semibold text-foreground tabular-nums">
                            {Math.round(c.churnLikelihood)}
                          </span>
                        )}
                        {band && <StatusPill tone={band.tone}>{band.label}</StatusPill>}
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 space-y-3">
                          {c.summary && <p className="text-xs text-gray-600 italic">{c.summary}</p>}
                          {c.findings.map((f) => (
                            <div
                              key={f.rank}
                              // Decorative indent rail (neutral list chrome, not a
                              // status signal) — exempt from the --status-* token
                              // sweep (Task #4492).
                              className="border-l-2 border-gray-200 pl-3 space-y-1"
                              data-testid={`finding-${c.clientId}-${f.rank}`}
                            >
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-muted-foreground">{f.rank}.</span>
                                <span className="text-sm text-foreground">{f.reason}</span>
                              </div>
                              <div className="flex items-center gap-2 flex-wrap text-caption">
                                <StatusPill tone={SEVERITY_TONE[f.severity] ?? "neutral"}>
                                  {f.severity}
                                </StatusPill>
                                <span className="text-muted-foreground">{f.themeLabel}</span>
                                {f.confidence !== null && (
                                  <span className="text-muted-foreground">confidence {(f.confidence * 100).toFixed(0)}%</span>
                                )}
                              </div>
                              {f.evidence.length > 0 && (
                                <ul className="text-caption text-gray-500 list-disc ml-4 space-y-0.5">
                                  {f.evidence.map((e, i) => (
                                    <li key={i}>{e}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {(insufficientClients.length > 0 || errorClients.length > 0) && (
                <div className="pt-2 space-y-1">
                  {insufficientClients.length > 0 && (
                    <Card data-testid="card-insufficient-clients">
                      <CardContent className="p-3">
                        <p className="text-xs font-medium text-gray-500 flex items-center gap-1.5 mb-1.5">
                          <FileQuestion className="w-3.5 h-3.5" />
                          Insufficient data ({insufficientClients.length})
                        </p>
                        <div className="space-y-1">
                          {insufficientClients.map((c) => (
                            <div key={c.clientId} className="text-xs text-gray-500 flex gap-2">
                              <span className="font-medium text-gray-600 shrink-0">{c.firmName}</span>
                              <span className="truncate">{c.insufficiencyReason}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {errorClients.length > 0 && (
                    <Card data-testid="card-error-clients">
                      <CardContent className="p-3">
                        <p className="text-xs font-medium text-status-critical flex items-center gap-1.5 mb-1.5">
                          <CircleSlash className="w-3.5 h-3.5" />
                          Analysis failed ({errorClients.length})
                        </p>
                        <div className="space-y-1">
                          {errorClients.map((c) => (
                            <div key={c.clientId} className="text-xs text-gray-500 flex gap-2">
                              <span className="font-medium text-gray-600 shrink-0">{c.firmName}</span>
                              <span className="truncate">{c.errorMessage}</span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}
            </div>
          )}

          {results && view === "themes" && (
            <div className="space-y-2" data-testid="list-radar-themes">
              {results.themes.length === 0 && (
                <Card>
                  <CardContent className="p-6 text-center text-sm text-gray-500">
                    No cross-client themes — no analyzed clients produced findings in this run.
                  </CardContent>
                </Card>
              )}
              {results.themes.map((t, idx) => {
                const key = `theme-${t.category}`;
                const isOpen = expanded.has(key);
                return (
                  <Card key={t.category} data-testid={`card-radar-theme-${t.category}`}>
                    <CardContent className="p-0">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(key)}
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-gray-50"
                        data-testid={`button-expand-theme-${t.category}`}
                      >
                        <span className="text-xs font-semibold text-muted-foreground w-6 shrink-0">#{idx + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-foreground truncate">{t.label}</p>
                          <p className="text-caption text-gray-500">
                            {t.clientCount} {t.clientCount === 1 ? "client" : "clients"}
                            {t.highRiskClientCount > 0 && `, ${t.highRiskClientCount} high-risk`} ·{" "}
                            {t.severityCounts.high} high / {t.severityCounts.medium} med / {t.severityCounts.low} low severity
                          </p>
                        </div>
                        <span className="text-caption text-muted-foreground tabular-nums shrink-0">
                          impact {t.impactScore}
                        </span>
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 space-y-3">
                          {t.representativeReasons.length > 0 && (
                            <ul className="text-xs text-gray-600 italic list-disc ml-4 space-y-0.5">
                              {t.representativeReasons.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                          <div className="space-y-1.5">
                            {t.affectedClients.map((c) => {
                              const band = BAND_CONFIG[c.likelihoodBand ?? ""] ?? null;
                              return (
                                <div
                                  key={c.clientId}
                                  className="text-xs flex items-start gap-2"
                                  data-testid={`theme-client-${t.category}-${c.clientId}`}
                                >
                                  <span className="font-medium text-gray-700 shrink-0">{c.firmName}</span>
                                  {band && (
                                    <StatusPill tone={band.tone} className="shrink-0">
                                      {band.label}
                                    </StatusPill>
                                  )}
                                  <span className="text-gray-500 min-w-0">{c.reasons.join(" · ")}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
