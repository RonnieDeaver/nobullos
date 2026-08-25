/**
 * Task #2784 / #2785 — Google Ads Hygiene (CEO-only).
 *
 * Tab 1: Audit — scored 8-category checklist (Task #2784 foundation).
 * Tab 2: Budget Pacing — MTD spend vs expected pace per campaign.
 * Tab 3: LSA Dashboard — Local Services Ads metrics & pacing.
 * Tab 4: Keyword Intel — keyword performance classification & suggestions.
 * Tab 5: Alerts — active hygiene alerts + optional ClickUp task creation.
 */

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient as sharedQueryClient } from "@/lib/queryClient";
import { parseGoogleAdsDisconnectedError } from "@shared/googleAdsDisconnect";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { matchAccounts, formatId } from "./accountSearch";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  ShieldCheck,
  PlayCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  Search,
  Bell,
  Gauge,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  ChevronsUpDown,
  Check,
} from "lucide-react";

// ─── Shared types ─────────────────────────────────────────────────────────────

type AccountRow = {
  customerId: string;
  descriptiveName: string | null;
  status: string;
  nobullClientId: string | null;
};

// ─── Audit types (Task #2784) ─────────────────────────────────────────────────

type AuditReportCheck = {
  checkId: string;
  categoryId: string;
  label: string;
  status: "good" | "okay" | "bad" | "critical" | "not_applicable";
  score: number | null;
  weight: number;
  measuredValue: string | null;
  affectedEntities: string[];
  recommendedFix: string | null;
  isGate: string | null;
  impactRank: number;
};

type AuditReport = {
  runId: string;
  customerId: string;
  scoreH: number;
  scoreHFinal: number;
  categoryScores: Record<string, number | null>;
  triggeredGates: { id: string; label: string; capAt: number; explanation: string }[];
  checks: AuditReportCheck[];
};

type AuditRunRow = {
  id: string;
  customerId: string;
  status: string;
  scoreH: number | null;
  scoreHFinal: number | null;
  createdAt: string;
};

// ─── Pacing types ─────────────────────────────────────────────────────────────

type PaceBand = "ahead" | "on_pace" | "slightly_behind" | "behind" | "no_data";

type CampaignPaceResult = {
  campaignId: string;
  campaignName: string | null;
  channelType: string | null;
  budgetDollarPerDay: number;
  expectedSpendToDate: number;
  actualSpendToDate: number;
  paceRatio: number | null;
  paceBand: PaceBand;
  daysElapsed: number;
  daysInMonth: number;
};

type PacingSummary = {
  campaigns: CampaignPaceResult[];
  daysElapsed: number;
  daysInMonth: number;
  accountTotalBudgetPerDay: number;
  accountExpectedSpend: number;
  accountActualSpend: number;
  accountPaceBand: PaceBand;
  overallPaceRatio: number | null;
};

// ─── LSA types ───────────────────────────────────────────────────────────────

type LsaMetric = {
  campaignId: string;
  campaignName: string | null;
  impressions: number;
  clicks: number;
  costDollars: number;
  conversions: number;
  budgetDollarPerDay: number;
  expectedSpendToDate: number;
  actualSpendToDate: number;
  paceBand: PaceBand;
  paceRatio: number | null;
  daysElapsed: number;
  daysInMonth: number;
};

type LsaDashboard = {
  hasLsaCampaigns: boolean;
  campaigns: LsaMetric[];
  totalSpendDollars: number;
  totalConversions: number;
  totalImpressions: number;
  accountPaceBand: PaceBand;
  note: string;
};

// ─── Keyword Intel types ──────────────────────────────────────────────────────

type KeywordIntelEntry = {
  campaignId: string;
  campaignName: string | null;
  adGroupId: string;
  keywordText: string;
  matchType: string | null;
  impressions: number;
  clicks: number;
  costDollars: number;
  conversions: number;
  avgCpcDollars: number;
  qualityScore: number | null;
  suggestionType: string;
  notes: string;
};

type KeywordIntelResult = {
  runAt: string;
  lookbackDays: number;
  totalKeywords: number;
  byType: Record<string, number>;
  entries: KeywordIntelEntry[];
};

// ─── Alert types ──────────────────────────────────────────────────────────────

type HygieneAlert = {
  id: string;
  customerId: string;
  alertType: string;
  severity: "warning" | "critical";
  title: string;
  detail: string | null;
  campaignId: string | null;
  campaignName: string | null;
  measuredValue: string | null;
  isResolved: "yes" | "no";
  resolvedAt: string | null;
  clickupTaskId: string | null;
  clickupTaskStatus: string | null;
  clickupTaskUrl: string | null;
  createdAt: string;
};

// ─── Display helpers ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  targeting_geo: "Targeting & Geo",
  keywords: "Keywords",
  bidding_budget: "Bidding & Budget",
  ads_creative: "Ads & Creative",
  assets: "Assets (Extensions)",
  policy: "Policy & Compliance",
  optimization_score: "Optimization Score",
  account_structure: "Account Structure",
};

const STATUS_BADGE: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-800 border-emerald-300",
  okay: "bg-amber-100 text-amber-800 border-amber-300",
  bad: "bg-orange-100 text-orange-800 border-orange-300",
  critical: "bg-red-100 text-red-800 border-red-300",
  not_applicable: "bg-muted text-muted-foreground border-muted",
};

function scoreColor(score: number): string {
  if (score >= 85) return "text-emerald-600";
  if (score >= 70) return "text-amber-600";
  if (score >= 50) return "text-orange-600";
  return "text-red-600";
}

const PACE_BAND_CONFIG: Record<PaceBand, { label: string; color: string; icon: React.ReactNode }> = {
  ahead: { label: "Ahead of Pace", color: "text-blue-600", icon: <TrendingUp className="h-4 w-4" /> },
  on_pace: { label: "On Pace", color: "text-emerald-600", icon: <Minus className="h-4 w-4" /> },
  slightly_behind: { label: "Slightly Behind", color: "text-amber-600", icon: <TrendingDown className="h-4 w-4" /> },
  behind: { label: "Behind Pace", color: "text-red-600", icon: <TrendingDown className="h-4 w-4" /> },
  no_data: { label: "No Data", color: "text-muted-foreground", icon: <Minus className="h-4 w-4" /> },
};

const SUGGESTION_TYPE_CONFIG: Record<string, { label: string; color: string }> = {
  low_quality: { label: "Low Quality Score", color: "bg-red-100 text-red-800 border-red-300" },
  negative_candidate: { label: "Negative Candidate", color: "bg-orange-100 text-orange-800 border-orange-300" },
  broad_risk: { label: "Broad Match Risk", color: "bg-amber-100 text-amber-800 border-amber-300" },
  missing_exact: { label: "Missing Exact Match", color: "bg-blue-100 text-blue-800 border-blue-300" },
  top_performer: { label: "Top Performer", color: "bg-emerald-100 text-emerald-800 border-emerald-300" },
};

function fmt$(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${Math.round(n * 100)}%`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function PaceBandBadge({ band }: { band: PaceBand }) {
  const cfg = PACE_BAND_CONFIG[band] ?? PACE_BAND_CONFIG.no_data;
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cfg.color}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function AccountPacingCard({ summary }: { summary: PacingSummary }) {
  const cfg = PACE_BAND_CONFIG[summary.accountPaceBand];
  return (
    <Card className="mb-4">
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-center gap-8">
          <div>
            <div className="text-xs text-muted-foreground">Account pace</div>
            <div className={`text-xl font-semibold flex items-center gap-1 ${cfg.color}`}>
              {cfg.icon} {cfg.label}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Pace ratio</div>
            <div className="text-lg font-medium">{fmtPct(summary.overallPaceRatio)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Actual spend MTD</div>
            <div className="text-lg font-medium">{fmt$(summary.accountActualSpend)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Expected spend MTD</div>
            <div className="text-lg font-medium">{fmt$(summary.accountExpectedSpend)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Days elapsed</div>
            <div className="text-lg font-medium">{summary.daysElapsed} / {summary.daysInMonth}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GoogleAdsHygieneAudit() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("audit");
  const [kwFilter, setKwFilter] = useState<string>("all");
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");

  // Task #4977: reads are open to any authenticated staff role; only the
  // mutation/trigger controls below stay CEO-gated.
  const isStaff = !!user;
  const isCeo = !!user && user.role === "ceo";

  // ── Accounts ──────────────────────────────────────────────────────────────

  const accountsQuery = useQuery<{ accounts: AccountRow[] }>({
    queryKey: ["/api/admin/google-ads-audit/accounts"],
    enabled: isStaff,
  });

  // ── Audit (Tab 1) ─────────────────────────────────────────────────────────

  const runsQuery = useQuery<{ runs: AuditRunRow[] }>({
    queryKey: ["/api/admin/google-ads-audit", customerId, "runs"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-audit/${customerId}/runs`);
      return res.json();
    },
    enabled: isStaff && !!customerId,
  });

  const reportQuery = useQuery<{ report: AuditReport; status: string; error: string | null }>({
    queryKey: ["/api/admin/google-ads-audit/runs", activeRunId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-audit/runs/${activeRunId}`);
      return res.json();
    },
    enabled: isStaff && !!activeRunId,
  });

  const runAuditMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/google-ads-audit/${customerId}/run`, {
        lookbackDays: 30,
      });
      return res.json() as Promise<{ report: AuditReport }>;
    },
    onSuccess: (data) => {
      setActiveRunId(data.report.runId);
      void qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-audit", customerId, "runs"] }); // fire-and-forget: cache refresh only
      sharedQueryClient.setQueryData(["/api/admin/google-ads-audit/runs", data.report.runId], {
        report: data.report,
        status: "completed",
        error: null,
      });
      toast({ title: "Audit complete", description: `Overall score: ${Math.round(data.report.scoreHFinal)}/100` });
    },
    onError: (error: any) => {
      // Task #2794 — the page-level reconnect banner owns the disconnected state.
      if (parseGoogleAdsDisconnectedError(error)) return;
      toast({ title: "Audit failed", description: error.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // ── Budget Pacing (Tab 2) ─────────────────────────────────────────────────

  const pacingQuery = useQuery<{ pacing: PacingSummary }>({
    queryKey: ["/api/admin/google-ads-hygiene", customerId, "pacing"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-hygiene/${customerId}/pacing`);
      return res.json();
    },
    enabled: isStaff && !!customerId && activeTab === "pacing",
    staleTime: 5 * 60 * 1000,
  });

  // ── LSA Dashboard (Tab 3) ─────────────────────────────────────────────────

  const lsaQuery = useQuery<{ lsa: LsaDashboard }>({
    queryKey: ["/api/admin/google-ads-hygiene", customerId, "lsa"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-hygiene/${customerId}/lsa`);
      return res.json();
    },
    enabled: isStaff && !!customerId && activeTab === "lsa",
    staleTime: 5 * 60 * 1000,
  });

  // ── Keyword Intel (Tab 4) ─────────────────────────────────────────────────

  const kwResultsQuery = useQuery<{ results: KeywordIntelEntry[]; runAt: string | null }>({
    queryKey: ["/api/admin/google-ads-hygiene", customerId, "keyword-intel", "results"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-hygiene/${customerId}/keyword-intel/results`);
      return res.json();
    },
    enabled: isStaff && !!customerId && activeTab === "keywords",
    staleTime: 5 * 60 * 1000,
  });

  const runKwIntelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/google-ads-hygiene/${customerId}/keyword-intel/run`, {
        lookbackDays: 30,
      });
      return res.json() as Promise<{ result: KeywordIntelResult }>;
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({
        queryKey: ["/api/admin/google-ads-hygiene", customerId, "keyword-intel", "results"],
      }); // fire-and-forget: cache refresh only
      toast({
        title: "Keyword Intel complete",
        description: `${data.result.entries.length} keywords flagged from ${data.result.totalKeywords} total.`,
      });
    },
    onError: (error: any) => {
      if (parseGoogleAdsDisconnectedError(error)) return;
      toast({ title: "Keyword Intel failed", description: error.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // ── Alerts (Tab 5) ────────────────────────────────────────────────────────

  const alertsQuery = useQuery<{ alerts: HygieneAlert[]; clickupConfigured: boolean }>({
    queryKey: ["/api/admin/google-ads-hygiene", customerId, "alerts"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/google-ads-hygiene/${customerId}/alerts`);
      return res.json();
    },
    enabled: isStaff && !!customerId && activeTab === "alerts",
    staleTime: 60 * 1000,
  });

  const computeAlertsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/google-ads-hygiene/${customerId}/alerts/compute`);
      return res.json() as Promise<{ alerts: HygieneAlert[]; count: number; clickupConfigured: boolean }>;
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "alerts"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Alerts computed",
        description: `${data.count} active alert${data.count === 1 ? "" : "s"} found.`,
      });
    },
    onError: (error: any) => {
      if (parseGoogleAdsDisconnectedError(error)) return;
      toast({ title: "Alert compute failed", description: error.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const resolveAlertMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const res = await apiRequest("POST", `/api/admin/google-ads-hygiene/alerts/${alertId}/resolve`);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "alerts"] }); // fire-and-forget: cache refresh only
    },
  });

  const createClickUpMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const res = await apiRequest("POST", `/api/admin/google-ads-hygiene/alerts/${alertId}/clickup`);
      return res.json();
    },
    onSuccess: (data) => {
      if (!data.clickupConfigured) {
        toast({
          title: "ClickUp not configured",
          description: data.reason ?? "Set CLICKUP_API_TOKEN and CLICKUP_LIST_ID secrets.",
          variant: "destructive",
        });
      } else {
        toast({ title: "ClickUp task created", description: data.task?.name ?? "Task created" });
      }
      void qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "alerts"] }); // fire-and-forget: cache refresh only
    },
    onError: (error: any) => {
      toast({ title: "ClickUp error", description: error.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const refreshClickUpMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const res = await apiRequest("POST", `/api/admin/google-ads-hygiene/alerts/${alertId}/clickup/refresh`);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "alerts"] }); // fire-and-forget: cache refresh only
    },
    onError: (error: any) => {
      toast({ title: "Refresh failed", description: error.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const accounts = useMemo(
    () => accountsQuery.data?.accounts ?? [],
    [accountsQuery.data?.accounts],
  );
  const labeledAccounts = useMemo(
    () => accounts.map((a) => ({ customerId: a.customerId, name: a.descriptiveName || a.customerId })),
    [accounts],
  );
  const filteredAccounts = useMemo(
    () => matchAccounts(labeledAccounts, accountSearch),
    [labeledAccounts, accountSearch],
  );
  const selectedAccount = useMemo(
    () => labeledAccounts.find((a) => a.customerId === customerId),
    [labeledAccounts, customerId],
  );
  const runs = runsQuery.data?.runs ?? [];
  const report = reportQuery.data?.report;

  const checksByCategory: Record<string, AuditReportCheck[]> = {};
  if (report) {
    for (const check of report.checks) {
      (checksByCategory[check.categoryId] ??= []).push(check);
    }
  }
  const topIssues = (report?.checks ?? []).filter((c) => c.score != null).slice(0, 5);

  const pacing = pacingQuery.data?.pacing;
  const lsa = lsaQuery.data?.lsa;
  const kwResults = kwResultsQuery.data?.results ?? [];
  const kwRunAt = kwResultsQuery.data?.runAt;
  const filteredKw = kwFilter === "all" ? kwResults : kwResults.filter((k) => k.suggestionType === kwFilter);
  const alerts = alertsQuery.data?.alerts ?? [];
  const clickupConfigured = alertsQuery.data?.clickupConfigured ?? false;

  // Task #2794 — one page-level reconnect banner when ANY query/mutation on
  // this page failed with the structured "google_ads_disconnected" 503.
  const googleAdsDisconnected =
    [
      accountsQuery.error,
      runsQuery.error,
      reportQuery.error,
      pacingQuery.error,
      lsaQuery.error,
      kwResultsQuery.error,
      alertsQuery.error,
      runAuditMutation.error,
      runKwIntelMutation.error,
      computeAlertsMutation.error,
    ]
      .map((e) => parseGoogleAdsDisconnectedError(e))
      .find((p) => p != null) ?? null;

  // ── Auth guard ─────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8" data-testid="status-loading">
        <Skeleton className="h-10 w-72" />
      </div>
    );
  }

  // Task #4977: any authenticated staff role may VIEW this page; a missing
  // user (role-less session) still gets the Forbidden wall.
  if (!isStaff) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8" data-testid="status-forbidden">
        <Card>
          <CardHeader><CardTitle>Forbidden</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">This page is restricted to signed-in team members.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8" data-testid="page-google-ads-hygiene-audit">
      <PageHeader
        title="Google Ads Hygiene"
        subtitle="Audit, pacing, keyword intelligence, and alerts — read-only against the connected account."
        icon={ShieldCheck}
        backHref="/admin/integrations"
        className="mb-6"
      />

      {googleAdsDisconnected && (
        <Card className="mb-6 border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950" data-testid="banner-google-ads-disconnected">
          <CardContent className="flex items-start gap-3 pt-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div>
              {/* Task #4008 — env-credential model: no in-app reconnect.
                  The fix is rotating the GOOGLE_ADS_* secret trio; the
                  Integrations Hub card shows the live credential state. */}
              <div className="font-medium text-red-800 dark:text-red-200" data-testid="text-google-ads-disconnected-message">
                Google Ads credentials are missing or were rejected — rotate the GOOGLE_ADS_* secret trio and restart (see <code>GOOGLE_ADS.md</code>). Status:{" "}
                <Link href="/admin/integrations" className="underline underline-offset-2" data-testid="link-reconnect-google-ads">
                  Settings → Integrations
                </Link>
                .
              </div>
              {googleAdsDisconnected.lastError && (
                <div className="mt-1 text-sm text-red-700 dark:text-red-300" data-testid="text-google-ads-last-error">
                  Last error: {googleAdsDisconnected.lastError}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Account selector — shared across all tabs */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Select account</CardTitle>
          <CardDescription>Pick a connected Google Ads account to analyze.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {accountsQuery.isLoading ? (
            <Skeleton className="h-10 w-64" />
          ) : (
            <Popover
              open={accountPickerOpen}
              onOpenChange={(open) => {
                setAccountPickerOpen(open);
                if (!open) setAccountSearch("");
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={accountPickerOpen}
                  className="w-72 justify-between font-normal"
                  data-testid="select-account"
                >
                  <span className="truncate">
                    {selectedAccount
                      ? `${selectedAccount.name} (${formatId(selectedAccount.customerId)})`
                      : "Choose an account"}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search by name or ID…"
                    value={accountSearch}
                    onValueChange={setAccountSearch}
                  />
                  <CommandList className="max-h-60">
                    <CommandEmpty>No accounts match.</CommandEmpty>
                    <CommandGroup>
                      {filteredAccounts.map((account) => (
                        <CommandItem
                          key={account.customerId}
                          value={account.customerId}
                          onSelect={() => {
                            setCustomerId(account.customerId);
                            setActiveRunId(null);
                            setAccountSearch("");
                            setAccountPickerOpen(false);
                          }}
                          data-testid={`option-account-${account.customerId}`}
                        >
                          <Check
                            className={`mr-2 h-4 w-4 ${customerId === account.customerId ? "opacity-100" : "opacity-0"}`}
                          />
                          {account.name} ({formatId(account.customerId)})
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
          {accounts.length === 0 && !accountsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">
              No accounts found. Connect Google Ads in the Integrations Hub and run discovery.
            </p>
          )}
        </CardContent>
      </Card>

      {!customerId && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-account">
            Select an account above to start analyzing.
          </CardContent>
        </Card>
      )}

      {customerId && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 w-full justify-start">
            <TabsTrigger value="audit" data-testid="tab-audit">
              <ShieldCheck className="mr-1.5 h-4 w-4" />
              Audit
            </TabsTrigger>
            <TabsTrigger value="pacing" data-testid="tab-pacing">
              <Gauge className="mr-1.5 h-4 w-4" />
              Budget Pacing
            </TabsTrigger>
            <TabsTrigger value="lsa" data-testid="tab-lsa">
              <TrendingUp className="mr-1.5 h-4 w-4" />
              LSA Dashboard
            </TabsTrigger>
            <TabsTrigger value="keywords" data-testid="tab-keywords">
              <Search className="mr-1.5 h-4 w-4" />
              Keyword Intel
            </TabsTrigger>
            <TabsTrigger value="alerts" data-testid="tab-alerts">
              <Bell className="mr-1.5 h-4 w-4" />
              Alerts
              {alerts.filter((a) => a.severity === "critical" && a.isResolved === "no").length > 0 && (
                <span className="ml-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-xs text-white">
                  {alerts.filter((a) => a.severity === "critical" && a.isResolved === "no").length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* ── Tab 1: Audit ─────────────────────────────────────────────── */}
          <TabsContent value="audit">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              {isCeo && (
              <Button
                onClick={() => runAuditMutation.mutate()}
                disabled={runAuditMutation.isPending}
                data-testid="button-run-audit"
              >
                <PlayCircle className="mr-2 h-4 w-4" />
                {runAuditMutation.isPending ? "Running audit…" : "Run new audit"}
              </Button>
              )}

              {runs.length > 0 && (
                <Select value={activeRunId ?? ""} onValueChange={(value) => setActiveRunId(value)}>
                  <SelectTrigger className="w-64" data-testid="select-past-run">
                    <SelectValue placeholder="View a past run" />
                  </SelectTrigger>
                  <SelectContent>
                    {runs.map((run) => (
                      <SelectItem key={run.id} value={run.id} data-testid={`option-run-${run.id}`}>
                        {new Date(run.createdAt).toLocaleString()} — {run.scoreHFinal != null ? Math.round(run.scoreHFinal) : "—"}/100
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {reportQuery.isFetching && (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}

            {report && !reportQuery.isFetching && (
              <>
                <Card className="mb-6">
                  <CardHeader><CardTitle className="text-base">Overall score</CardTitle></CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap items-end gap-8">
                      <div>
                        <div className={`text-4xl font-bold ${scoreColor(report.scoreHFinal)}`} data-testid="text-score-final">
                          {Math.round(report.scoreHFinal)}
                        </div>
                        <div className="text-xs text-muted-foreground">Final score (after gate caps)</div>
                      </div>
                      {Math.round(report.scoreH) !== Math.round(report.scoreHFinal) && (
                        <div>
                          <div className="text-2xl font-medium text-muted-foreground" data-testid="text-score-raw">
                            {Math.round(report.scoreH)}
                          </div>
                          <div className="text-xs text-muted-foreground">Raw weighted score (before caps)</div>
                        </div>
                      )}
                    </div>
                    {report.triggeredGates.length > 0 && (
                      <div className="mt-4 space-y-2">
                        {report.triggeredGates.map((gate) => (
                          <div key={gate.id} className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid={`gate-${gate.id}`}>
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <div>
                              <div className="font-medium">{gate.label} — capped at {gate.capAt}</div>
                              <div className="text-red-700">{gate.explanation}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
                  {Object.entries(report.categoryScores).map(([categoryId, score]) => (
                    <Card key={categoryId} data-testid={`card-category-${categoryId}`}>
                      <CardContent className="pt-4">
                        <div className="text-xs font-medium text-muted-foreground">{CATEGORY_LABELS[categoryId] ?? categoryId}</div>
                        <div className={`text-xl font-semibold ${score != null ? scoreColor(score) : "text-muted-foreground"}`}>
                          {score != null ? Math.round(score) : "N/A"}
                        </div>
                        <Progress value={score ?? 0} className="mt-2 h-1.5" />
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {topIssues.length > 0 && (
                  <Card className="mb-6" data-testid="card-top-issues">
                    <CardHeader>
                      <CardTitle className="text-base">Top issues by impact</CardTitle>
                      <CardDescription>Ranked by lowest score — fix these first.</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {topIssues.map((check) => (
                          <div key={check.checkId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3" data-testid={`top-issue-${check.checkId}`}>
                            <div className="flex items-center gap-2">
                              <Badge variant="secondary" data-testid={`badge-impact-rank-${check.checkId}`}>#{check.impactRank}</Badge>
                              <span className="font-medium">{check.label}</span>
                              <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[check.categoryId] ?? check.categoryId}</span>
                            </div>
                            <Badge variant="outline" className={STATUS_BADGE[check.status]}>{check.status.replace("_", " ")}</Badge>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Checklist detail</CardTitle>
                    <CardDescription>Expand a category to see every check and its recommended fix.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Accordion type="multiple" className="w-full">
                      {Object.entries(checksByCategory).map(([categoryId, checks]) => (
                        <AccordionItem key={categoryId} value={categoryId}>
                          <AccordionTrigger data-testid={`accordion-category-${categoryId}`}>
                            <span className="flex items-center gap-2">
                              {CATEGORY_LABELS[categoryId] ?? categoryId}
                              <Badge variant="outline" className={STATUS_BADGE[report.categoryScores[categoryId] != null && report.categoryScores[categoryId]! >= 85 ? "good" : "okay"]}>
                                {report.categoryScores[categoryId] != null ? Math.round(report.categoryScores[categoryId]!) : "N/A"}
                              </Badge>
                            </span>
                          </AccordionTrigger>
                          <AccordionContent>
                            <div className="space-y-3">
                              {checks.map((check) => (
                                <div key={check.checkId} className="rounded-md border p-3" data-testid={`check-${check.checkId}`}>
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="font-medium">{check.label}</div>
                                    <Badge variant="outline" className={STATUS_BADGE[check.status]} data-testid={`badge-status-${check.checkId}`}>
                                      {check.status.replace("_", " ")}
                                    </Badge>
                                  </div>
                                  {check.measuredValue && <div className="mt-1 text-sm text-muted-foreground">Measured: {check.measuredValue}</div>}
                                  {check.affectedEntities.length > 0 && (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                      Affected: {check.affectedEntities.slice(0, 5).join(", ")}
                                      {check.affectedEntities.length > 5 ? ` +${check.affectedEntities.length - 5} more` : ""}
                                    </div>
                                  )}
                                  {check.recommendedFix && <div className="mt-2 rounded bg-muted p-2 text-sm">{check.recommendedFix}</div>}
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </CardContent>
                </Card>
              </>
            )}

            {!report && !reportQuery.isFetching && (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-report">
                  No audit run selected yet. Click "Run new audit" or pick a past run above.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Tab 2: Budget Pacing ──────────────────────────────────────── */}
          <TabsContent value="pacing">
            <div className="mb-4 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "pacing"] })}
                disabled={pacingQuery.isFetching}
                data-testid="button-refresh-pacing"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${pacingQuery.isFetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            {pacingQuery.isLoading && <Skeleton className="h-64 w-full" />}
            {pacingQuery.error && !parseGoogleAdsDisconnectedError(pacingQuery.error) && (
              <Card><CardContent className="py-8 text-center text-destructive">Failed to load pacing data.</CardContent></Card>
            )}

            {pacing && (
              <>
                <AccountPacingCard summary={pacing} />
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Per-campaign pacing</CardTitle>
                    <CardDescription>
                      MTD spend vs expected spend ({pacing.daysElapsed} of {pacing.daysInMonth} days elapsed).
                      Excluded: Local Services Ads campaigns (shown in LSA tab).
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {pacing.campaigns.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No active campaigns found for this account.</p>
                    ) : (
                      <div className="space-y-3">
                        {pacing.campaigns.map((c) => (
                          <div key={c.campaignId} className="rounded-md border p-4" data-testid={`pacing-campaign-${c.campaignId}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div>
                                <div className="font-medium">{c.campaignName ?? c.campaignId}</div>
                                {c.channelType && <div className="text-xs text-muted-foreground">{c.channelType}</div>}
                              </div>
                              <PaceBandBadge band={c.paceBand} />
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                              <div>
                                <div className="text-xs text-muted-foreground">Daily budget</div>
                                <div className="font-medium">{fmt$(c.budgetDollarPerDay)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Expected MTD</div>
                                <div className="font-medium">{fmt$(c.expectedSpendToDate)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Actual MTD</div>
                                <div className="font-medium">{fmt$(c.actualSpendToDate)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Pace ratio</div>
                                <div className="font-medium">{fmtPct(c.paceRatio)}</div>
                              </div>
                            </div>
                            {c.paceRatio != null && (
                              <Progress
                                value={Math.min(100, c.paceRatio * 100)}
                                className="mt-3 h-1.5"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          {/* ── Tab 3: LSA Dashboard ──────────────────────────────────────── */}
          <TabsContent value="lsa">
            <div className="mb-4 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => qc.invalidateQueries({ queryKey: ["/api/admin/google-ads-hygiene", customerId, "lsa"] })}
                disabled={lsaQuery.isFetching}
                data-testid="button-refresh-lsa"
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${lsaQuery.isFetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            {lsaQuery.isLoading && <Skeleton className="h-64 w-full" />}
            {lsaQuery.error && !parseGoogleAdsDisconnectedError(lsaQuery.error) && (
              <Card><CardContent className="py-8 text-center text-destructive">Failed to load LSA data.</CardContent></Card>
            )}

            {lsa && (
              <>
                {lsa.note && (
                  <div className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800" data-testid="lsa-note">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{lsa.note}</span>
                  </div>
                )}

                {!lsa.hasLsaCampaigns ? (
                  <Card>
                    <CardContent className="py-10 text-center text-muted-foreground" data-testid="lsa-no-campaigns">
                      No active Local Services Ads campaigns found for this account.
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-xs text-muted-foreground">Total spend MTD</div>
                          <div className="text-xl font-semibold">{fmt$(lsa.totalSpendDollars)}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-xs text-muted-foreground">Conversions MTD</div>
                          <div className="text-xl font-semibold">{lsa.totalConversions.toLocaleString()}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-xs text-muted-foreground">Impressions MTD</div>
                          <div className="text-xl font-semibold">{lsa.totalImpressions.toLocaleString()}</div>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardContent className="pt-4">
                          <div className="text-xs text-muted-foreground">Account pace</div>
                          <div className="mt-1"><PaceBandBadge band={lsa.accountPaceBand} /></div>
                        </CardContent>
                      </Card>
                    </div>

                    <Card>
                      <CardHeader>
                        <CardTitle className="text-base">LSA campaigns</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {lsa.campaigns.map((c) => (
                            <div key={c.campaignId} className="rounded-md border p-4" data-testid={`lsa-campaign-${c.campaignId}`}>
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="font-medium">{c.campaignName ?? c.campaignId}</div>
                                <PaceBandBadge band={c.paceBand} />
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
                                <div>
                                  <div className="text-xs text-muted-foreground">Spend MTD</div>
                                  <div className="font-medium">{fmt$(c.costDollars)}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-muted-foreground">Conversions</div>
                                  <div className="font-medium">{c.conversions.toLocaleString()}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-muted-foreground">Impressions</div>
                                  <div className="font-medium">{c.impressions.toLocaleString()}</div>
                                </div>
                                <div>
                                  <div className="text-xs text-muted-foreground">Pace ratio</div>
                                  <div className="font-medium">{fmtPct(c.paceRatio)}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </>
                )}
              </>
            )}
          </TabsContent>

          {/* ── Tab 4: Keyword Intel ──────────────────────────────────────── */}
          <TabsContent value="keywords">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              {isCeo && (
              <Button
                onClick={() => runKwIntelMutation.mutate()}
                disabled={runKwIntelMutation.isPending}
                data-testid="button-run-keyword-intel"
              >
                <Search className="mr-2 h-4 w-4" />
                {runKwIntelMutation.isPending ? "Analyzing…" : "Run keyword analysis"}
              </Button>
              )}
              {kwRunAt && (
                <span className="text-sm text-muted-foreground" data-testid="text-kw-run-at">
                  Last run: {new Date(kwRunAt).toLocaleString()}
                </span>
              )}
            </div>

            {kwResultsQuery.isLoading && <Skeleton className="h-64 w-full" />}

            {kwResults.length > 0 && (
              <>
                <div className="mb-4 flex flex-wrap gap-2" data-testid="kw-type-filters">
                  <Button variant={kwFilter === "all" ? "default" : "outline"} size="sm" onClick={() => setKwFilter("all")} data-testid="filter-kw-all">
                    All ({kwResults.length})
                  </Button>
                  {Object.entries(SUGGESTION_TYPE_CONFIG).map(([type, cfg]) => {
                    const count = kwResults.filter((k) => k.suggestionType === type).length;
                    if (count === 0) return null;
                    return (
                      <Button key={type} variant={kwFilter === type ? "default" : "outline"} size="sm" onClick={() => setKwFilter(type)} data-testid={`filter-kw-${type}`}>
                        {cfg.label} ({count})
                      </Button>
                    );
                  })}
                </div>

                <Card>
                  <CardContent className="pt-4">
                    <div className="space-y-3">
                      {filteredKw.map((kw, i) => {
                        const cfg = SUGGESTION_TYPE_CONFIG[kw.suggestionType] ?? SUGGESTION_TYPE_CONFIG.low_quality;
                        return (
                          <div key={`${kw.campaignId}-${kw.adGroupId}-${kw.keywordText}-${i}`} className="rounded-md border p-4" data-testid={`kw-row-${i}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{kw.keywordText}</span>
                                {kw.matchType && <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{kw.matchType}</span>}
                              </div>
                              <Badge variant="outline" className={cfg.color}>{cfg.label}</Badge>
                            </div>
                            {kw.campaignName && (
                              <div className="mt-1 text-xs text-muted-foreground">Campaign: {kw.campaignName}</div>
                            )}
                            <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
                              <div>
                                <div className="text-xs text-muted-foreground">Impressions</div>
                                <div className="font-medium">{kw.impressions.toLocaleString()}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Clicks</div>
                                <div className="font-medium">{kw.clicks.toLocaleString()}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Cost</div>
                                <div className="font-medium">{fmt$(kw.costDollars)}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Conversions</div>
                                <div className="font-medium">{kw.conversions}</div>
                              </div>
                              <div>
                                <div className="text-xs text-muted-foreground">Quality Score</div>
                                <div className={`font-medium ${kw.qualityScore != null && kw.qualityScore <= 5 ? "text-red-600" : kw.qualityScore != null && kw.qualityScore >= 8 ? "text-emerald-600" : ""}`}>
                                  {kw.qualityScore != null ? `${kw.qualityScore}/10` : "—"}
                                </div>
                              </div>
                            </div>
                            {kw.notes && (
                              <div className="mt-2 rounded bg-muted p-2 text-sm">{kw.notes}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {!kwResultsQuery.isLoading && kwResults.length === 0 && !runKwIntelMutation.isPending && (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-kw-results">
                  No keyword analysis results yet. Click "Run keyword analysis" to start.
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ── Tab 5: Alerts ─────────────────────────────────────────────── */}
          <TabsContent value="alerts">
            <div className="mb-4 flex flex-wrap items-center gap-3">
              {isCeo && (
              <Button
                onClick={() => computeAlertsMutation.mutate()}
                disabled={computeAlertsMutation.isPending}
                data-testid="button-compute-alerts"
              >
                <Bell className="mr-2 h-4 w-4" />
                {computeAlertsMutation.isPending ? "Computing…" : "Compute alerts"}
              </Button>
              )}
              {!clickupConfigured && (
                <span className="text-sm text-muted-foreground" data-testid="text-clickup-unconfigured">
                  ClickUp not configured — set <code className="rounded bg-muted px-1 py-0.5 text-xs">CLICKUP_API_TOKEN</code> and{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">CLICKUP_LIST_ID</code> secrets to enable task creation.
                </span>
              )}
            </div>

            {alertsQuery.isLoading && <Skeleton className="h-64 w-full" />}

            {alerts.length === 0 && !alertsQuery.isLoading && (
              <Card>
                <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-alerts">
                  No active alerts. Click "Compute alerts" to check for budget pacing issues and disapprovals.
                </CardContent>
              </Card>
            )}

            {alerts.length > 0 && (
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <Card key={alert.id} className={alert.severity === "critical" ? "border-red-300" : "border-amber-200"} data-testid={`alert-${alert.id}`}>
                    <CardContent className="pt-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className={alert.severity === "critical" ? "border-red-300 bg-red-50 text-red-700" : "border-amber-300 bg-amber-50 text-amber-700"}
                              data-testid={`alert-severity-${alert.id}`}
                            >
                              {alert.severity}
                            </Badge>
                            <span className="font-medium" data-testid={`alert-title-${alert.id}`}>{alert.title}</span>
                          </div>
                          {alert.detail && (
                            <p className="mt-1 text-sm text-muted-foreground">{alert.detail}</p>
                          )}
                          {alert.measuredValue && (
                            <p className="mt-1 text-xs text-muted-foreground">Measured: {alert.measuredValue}</p>
                          )}
                          {alert.clickupTaskId && (
                            <div className="mt-2 flex items-center gap-2 text-sm" data-testid={`alert-clickup-${alert.id}`}>
                              <span className="text-muted-foreground">ClickUp:</span>
                              <Badge variant="outline" className={alert.clickupTaskStatus === "closed" ? "border-emerald-300 bg-emerald-50 text-emerald-700" : ""}>
                                {alert.clickupTaskStatus ?? "unknown"}
                              </Badge>
                              {alert.clickupTaskUrl && (
                                <a href={alert.clickupTaskUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-ink hover:underline" data-testid={`alert-clickup-link-${alert.id}`}>
                                  Open <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          )}
                        </div>

                        {isCeo && (
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                          {!alert.clickupTaskId ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => createClickUpMutation.mutate(alert.id)}
                              disabled={createClickUpMutation.isPending}
                              data-testid={`button-create-clickup-${alert.id}`}
                            >
                              Create ClickUp task
                            </Button>
                          ) : alert.clickupTaskStatus !== "closed" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => refreshClickUpMutation.mutate(alert.id)}
                              disabled={refreshClickUpMutation.isPending}
                              data-testid={`button-refresh-clickup-${alert.id}`}
                            >
                              <RefreshCw className="mr-1.5 h-3 w-3" />
                              Refresh status
                            </Button>
                          ) : (
                            <span className="flex items-center gap-1 text-sm text-emerald-600">
                              <CheckCircle2 className="h-4 w-4" />
                              Done in ClickUp
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => resolveAlertMutation.mutate(alert.id)}
                            disabled={resolveAlertMutation.isPending}
                            data-testid={`button-resolve-alert-${alert.id}`}
                          >
                            Resolve
                          </Button>
                        </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
