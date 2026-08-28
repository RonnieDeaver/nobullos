import React, { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  ArrowLeft, Building2, MapPin, TrendingUp, AlertTriangle,
  CheckCircle, XCircle, Users, BarChart3, Map, ChevronDown, ChevronUp,
  RefreshCw, Loader2, Info, ArrowRight, Globe
} from "lucide-react";
import { UsStateMap, type StateData } from "@/components/UsStateMap";
import { StateZoomMap, type MarketAreaDot } from "@/components/StateZoomMap";
import { CAPACITY_STATUS_COLORS, CAPACITY_STATUS_LEGEND } from "@/lib/capacityStatusColors";
import { HexGridMap } from "@/components/HexGridMap";
import { McuDashboardSkeleton, McuContentSkeleton } from "@/components/ui/skeleton-loaders";

type CapacityStatus = "Open" | "Filling" | "Tight" | "Saturated";
type OverlapRisk = "Low" | "Moderate" | "High";

interface PracticeSummary {
  practiceArea: string;
  capacityUsedPercent: number;
  status: CapacityStatus;
  statusColor: "green" | "yellow" | "orange" | "red";
  mcuTotal: number;
  mcuAllocated: number;
  mcuRemaining: number;
  overlapRisk: OverlapRisk;
  marketPopulation?: number;
  uniqueClients?: number;
  competitorsInZone?: number;
  rMarket?: number;
  strongInfluenceRadius?: number;
  totalOpportunity?: number;
  usedOpportunity?: number;
}

interface MarketAreaSummary {
  marketAreaId: string;
  marketAreaName: string;
  state: string;
  centerLat: number;
  centerLng: number;
  locationCount: number;
  clientCount: number;
  r2Radius?: number;
  rMarketRadius?: number;
  radiusDiagnostics?: {
    competitorsAnalyzed: number;
    r2Base: number;
    densityCore?: number;
    popDensity3mi?: number;
    popFactor?: number;
    isDense?: boolean;
    competitorsWithin20mi?: number;
    rMarket?: number;
  };
  practices: PracticeSummary[];
  locations: Array<{
    locationId: string;
    clientId: string;
    clientName: string;
    address: string;
    city: string;
    practiceAreas: string[];
    mcuRemaining: number;
    overlapPercent: number;
  }>;
  topExternalOverlaps: Array<{
    clientId: string;
    clientName: string;
    address: string;
    overlapPercent: number;
  }>;
}

interface InternalResult {
  address: string;
  verdict: "approved" | "conditional" | "decline";
  currentCapacityUsedPercent: number;
  projectedCapacityUsedPercent: number;
  currentStatus: "Open" | "Filling" | "Tight" | "Saturated";
  projectedStatus: "Open" | "Filling" | "Tight" | "Saturated";
  currentStatusColor: "green" | "yellow" | "orange" | "red";
  projectedStatusColor: "green" | "yellow" | "orange" | "red";
  deltaCapacityPercent: number;
  narrative: string;
  marketAreaName: string | null;
  existingClientCount: number;
  competitorsInZone: number;
  prospectR2: number | null;
  prospectR1: number | null;
  rMarket: number | null;
  mcuTotal: number;
  mcuRemaining: number;
  overlapRisk: "Low" | "Moderate" | "High";
}

interface StateRollup {
  state: string;
  capacityUsedPercent: number;
  status: CapacityStatus;
  statusColor: "green" | "yellow" | "orange" | "red";
  marketAreaCount: number;
  totalPopulation: number;
  totalCompetitors: number;
  totalMcu: number;
  totalAllocated: number;
  totalRemaining: number;
  clientCount: number;
  locationCount: number;
  marketAreas: MarketAreaSummary[];
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia"
};

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

function getCapacityStatus(pct: number): { status: CapacityStatus; color: "green" | "yellow" | "orange" | "red" } {
  if (pct < 35) return { status: "Open", color: "green" };
  if (pct < 60) return { status: "Filling", color: "yellow" };
  if (pct < 80) return { status: "Tight", color: "orange" };
  return { status: "Saturated", color: "red" };
}

function getOverlapRiskBadge(risk: OverlapRisk) {
  switch (risk) {
    case "Low": return "bg-status-ok/10 text-status-ok border-status-ok/40";
    case "Moderate": return "bg-status-warn/10 text-status-warn border-status-warn/40";
    case "High": return "bg-status-critical/10 text-status-critical border-status-critical/40";
    default: return "bg-muted text-foreground";
  }
}

function MetricTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 cursor-help">
            {label}
            <Info className="w-3 h-3 text-muted-foreground" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function McuDashboard() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  usePageTitle("MCU Dashboard");
  const queryClient = useQueryClient();

  const [stateFilter, setStateFilter] = useState("_all");
  const [practiceFilter, setPracticeFilter] = useState("_all");
  const [statusFilters, setStatusFilters] = useState<Set<string>>(new Set(["Open", "Filling", "Tight", "Saturated"]));
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [selectedMarketArea, setSelectedMarketArea] = useState<string | null>(null);
  const [hoveredState, setHoveredState] = useState<string | null>(null);
  const [refreshTriggeredAt, setRefreshTriggeredAt] = useState<number | null>(null);

  const [addressesText, setAddressesText] = useState("");
  const [practiceArea, setPracticeArea] = useState("");
  const [results, setResults] = useState<InternalResult[] | null>(null);

  const { data: practiceAreas } = useQuery<string[]>({
    queryKey: ["/api/mcu/practice-areas"],
    queryFn: async () => {
      const res = await fetch("/api/mcu/practice-areas");
      if (!res.ok) throw new Error("Failed to fetch practice areas");
      return res.json();
    },
  });

  interface SummaryResponse {
    status: string;
    lastComputedAt: string | null;
    progress: string;
    percent: number;
    etaSeconds: number | null;
    error: string | null;
    data: MarketAreaSummary[];
    isComputing?: boolean;
  }

  const { data: summaryResponse, isLoading: summaryLoading } = useQuery<SummaryResponse>({
    queryKey: ["/api/mcu/internal/summary", stateFilter, practiceFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (stateFilter && stateFilter !== "_all") params.set("state", stateFilter);
      if (practiceFilter && practiceFilter !== "_all") params.set("practice", practiceFilter);
      const res = await fetch(`/api/mcu/internal/summary?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch summary");
      return res.json();
    },
    enabled: !!user,
    staleTime: 0,
    refetchOnMount: true,
    refetchInterval: (query) => {
      const d = query.state.data as SummaryResponse | undefined;
      if (d && (d.isComputing || d.status === "computing" || d.status === "idle" || d.status === "refreshing")) return 2000;
      if (refreshTriggeredAt !== null && (Date.now() - refreshTriggeredAt) < 15000) return 2000;
      return false;
    },
  });

  const marketAreaSummaries = summaryResponse?.data;
  const serverIsComputing = summaryResponse?.isComputing || summaryResponse?.status === "computing";
  const computeStatus = summaryResponse?.status || "idle";
  const computeProgress = summaryResponse?.progress || "";
  const computePercent = summaryResponse?.percent ?? 0;
  const computeEtaSeconds = summaryResponse?.etaSeconds ?? null;
  const lastComputedAt = summaryResponse?.lastComputedAt;

  const formatEta = (seconds: number): string => {
    if (seconds < 60) return `~${seconds}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `~${mins}m ${secs}s remaining`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `~${hrs}h ${remainMins}m remaining`;
  };

  const refreshMutation = useMutation({
    mutationFn: async (opts: { clearRadii?: boolean; clearProbeCache?: boolean } | void) => {
      const res = await fetch("/api/mcu/internal/summary/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts || {}),
      });
      if (!res.ok) throw new Error("Failed to trigger refresh");
      return res.json();
    },
    onSuccess: () => {
      setRefreshTriggeredAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["/api/mcu/internal/summary"] }); // fire-and-forget: cache refresh only
    },
    onError: (error: Error) => {
      toast({
        title: "Refresh failed",
        description: error.message || "Could not trigger a capacity recompute. Try again.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    if (serverIsComputing && refreshTriggeredAt !== null) {
      setRefreshTriggeredAt(null);
    }
  }, [serverIsComputing, refreshTriggeredAt]);

  const isRefreshing = refreshMutation.isPending
    || (refreshTriggeredAt !== null && (Date.now() - refreshTriggeredAt) < 15000)
    || !!serverIsComputing;

  const stateRollups = useMemo<Record<string, StateRollup>>(() => {
    if (!marketAreaSummaries) return {};
    const rollups: Record<string, StateRollup> = {};
    for (const area of marketAreaSummaries) {
      const st = area.state;
      if (!rollups[st]) {
        rollups[st] = {
          state: st,
          capacityUsedPercent: 0,
          status: "Open",
          statusColor: "green",
          marketAreaCount: 0,
          totalPopulation: 0,
          totalCompetitors: 0,
          totalMcu: 0,
          totalAllocated: 0,
          totalRemaining: 0,
          clientCount: 0,
          locationCount: 0,
          marketAreas: [],
        };
      }
      const r = rollups[st];
      r.marketAreaCount++;
      r.locationCount += area.locationCount;
      r.clientCount += area.clientCount;
      r.marketAreas.push(area);
      for (const p of area.practices) {
        r.totalPopulation += p.marketPopulation || 0;
        r.totalCompetitors += p.competitorsInZone || 0;
        r.totalMcu += p.mcuTotal;
        r.totalAllocated += p.mcuAllocated;
        r.totalRemaining += p.mcuRemaining;
      }
    }
    const statusOrder: Record<string, number> = { "Open": 0, "Filling": 1, "Tight": 2, "Saturated": 3 };
    for (const st of Object.keys(rollups)) {
      const r = rollups[st];
      r.capacityUsedPercent = r.totalMcu > 0 ? Math.round((r.totalAllocated / r.totalMcu) * 100) : 0;
      let worstStatus: CapacityStatus = "Open";
      let worstColor: "green" | "yellow" | "orange" | "red" = "green";
      for (const area of r.marketAreas) {
        for (const p of area.practices) {
          if ((statusOrder[p.status] || 0) > (statusOrder[worstStatus] || 0)) {
            worstStatus = p.status;
            worstColor = p.statusColor;
          }
        }
      }
      r.status = worstStatus;
      r.statusColor = worstColor;
    }
    return rollups;
  }, [marketAreaSummaries]);

  const stateDataForMap = useMemo<Record<string, StateData>>(() => {
    const data: Record<string, StateData> = {};
    for (const [st, rollup] of Object.entries(stateRollups)) {
      if (!statusFilters.has(rollup.status)) continue;
      data[st] = {
        capacityUsedPercent: rollup.capacityUsedPercent,
        status: rollup.status,
        statusColor: rollup.statusColor,
        marketAreaCount: rollup.marketAreaCount,
        totalPopulation: rollup.totalPopulation,
        totalMcu: rollup.totalMcu,
        totalAllocated: rollup.totalAllocated,
      };
    }
    return data;
  }, [stateRollups, statusFilters]);

  const globalStats = useMemo(() => {
    const totals = { population: 0, mcu: 0, allocated: 0, remaining: 0, markets: 0, clients: 0, locations: 0 };
    for (const r of Object.values(stateRollups)) {
      totals.population += r.totalPopulation;
      totals.mcu += r.totalMcu;
      totals.allocated += r.totalAllocated;
      totals.remaining += r.totalRemaining;
      totals.markets += r.marketAreaCount;
      totals.clients += r.clientCount;
      totals.locations += r.locationCount;
    }
    return totals;
  }, [stateRollups]);

  const selectedStateData = selectedState ? stateRollups[selectedState] : null;

  const filteredMarketAreas = useMemo(() => {
    if (selectedStateData) {
      return selectedStateData.marketAreas.filter(area => {
        const practices = practiceFilter !== "_all" ? area.practices.filter(p => p.practiceArea === practiceFilter) : area.practices;
        if (practices.length === 0) return false;
        const avgCap = practices.reduce((sum, p) => sum + p.capacityUsedPercent, 0) / practices.length;
        const { status } = getCapacityStatus(avgCap);
        return statusFilters.has(status);
      });
    }
    return [];
  }, [selectedStateData, practiceFilter, statusFilters]);

  const stateZoomDots = useMemo<MarketAreaDot[]>(() => {
    return filteredMarketAreas.map(area => {
      const practices = practiceFilter !== "_all" ? area.practices.filter(p => p.practiceArea === practiceFilter) : area.practices;
      const avgCap = practices.length > 0 ? Math.round(practices.reduce((s, p) => s + p.capacityUsedPercent, 0) / practices.length) : 0;
      const { status, color } = getCapacityStatus(avgCap);
      const totalPop = practices.reduce((s, p) => s + (p.marketPopulation || 0), 0);
      const totalMcu = practices.reduce((s, p) => s + p.mcuTotal, 0);
      const totalAllocated = practices.reduce((s, p) => s + p.mcuAllocated, 0);
      return {
        marketAreaId: area.marketAreaId,
        marketAreaName: area.marketAreaName,
        centerLat: area.centerLat,
        centerLng: area.centerLng,
        locationCount: area.locationCount,
        clientCount: area.clientCount,
        capacityUsedPercent: avgCap,
        status,
        statusColor: color,
        totalPopulation: totalPop,
        totalMcu,
        totalAllocated,
        r2Radius: area.r2Radius,
      };
    });
  }, [filteredMarketAreas, practiceFilter]);

  const selectedArea = useMemo(() => {
    if (!selectedMarketArea || !marketAreaSummaries) return null;
    return marketAreaSummaries.find(a => a.marketAreaId === selectedMarketArea) || null;
  }, [selectedMarketArea, marketAreaSummaries]);

  const toggleStatusFilter = (status: string) => {
    setStatusFilters(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const evaluateMutation = useMutation({
    mutationFn: async (data: { addresses: string[]; practiceArea: string }) => {
      const res = await fetch("/api/mcu/internal/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to evaluate");
      return res.json();
    },
    onSuccess: (data) => setResults(data.results),
    onError: (error: Error) => {
      toast({
        title: "Evaluation failed",
        description: error.message || "Could not check capacity for these addresses. Try again.",
        variant: "destructive",
      });
    },
  });

  const handleEvaluate = () => {
    const addresses = addressesText.split("\n").map(a => a.trim()).filter(a => a.length > 0);
    if (addresses.length === 0 || !practiceArea) return;
    evaluateMutation.mutate({ addresses, practiceArea });
  };

  if (authLoading) {
    return <McuDashboardSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-muted-foreground">Please log in to access this page.</div>
      </div>
    );
  }

  const getVerdictConfig = (verdict: string) => {
    switch (verdict) {
      case "approved": return { icon: CheckCircle, color: "text-status-ok", bg: "bg-status-ok/5 border-status-ok/40" };
      case "conditional": return { icon: AlertTriangle, color: "text-status-warn", bg: "bg-status-warn/5 border-status-warn/40" };
      case "decline": return { icon: XCircle, color: "text-status-critical", bg: "bg-status-critical/5 border-status-critical/40" };
      default: return { icon: AlertTriangle, color: "text-muted-foreground", bg: "bg-muted/50 border-border" };
    }
  };

  const renderComputeStatus = () => {
    if (isRefreshing) {
      const progressDetail = computeProgress
        ? computeProgress.replace(/^Computing radii: /, '')
        : '';
      const showPercent = serverIsComputing && computePercent > 0;
      const statusText = showPercent
        ? `Recomputing... ${computePercent}%`
        : serverIsComputing
        ? "Recomputing market data..."
        : "Starting recomputation...";
      return (
        <div className="flex flex-col gap-1 bg-primary/10 px-3 py-1.5 rounded-md border border-primary/20">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-sm font-medium text-foreground">
              {statusText}
              {computeEtaSeconds !== null && computeEtaSeconds > 0 ? ` (${formatEta(computeEtaSeconds)})` : ""}
            </span>
            {showPercent && (
              <div className="w-24 bg-muted rounded-full h-2 overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${computePercent}%` }} />
              </div>
            )}
          </div>
          {progressDetail && serverIsComputing && (
            <span className="text-xs text-muted-foreground ml-6 truncate max-w-md" data-testid="compute-progress-detail">
              {progressDetail}
            </span>
          )}
        </div>
      );
    }
    if (computeStatus === "error" && marketAreaSummaries && marketAreaSummaries.length > 0) {
      return (
        <div className="flex items-center gap-2 bg-status-warn/10 px-3 py-1.5 rounded-md border border-status-warn/40" data-testid="mcu-recompute-error">
          <AlertTriangle className="w-4 h-4 text-status-warn flex-shrink-0" />
          <span className="text-sm text-foreground">
            Recompute failed{summaryResponse?.error ? `: ${summaryResponse.error.slice(0, 80)}` : ""}. Showing previous data.
          </span>
          <Button variant="ghost" size="sm" className="ml-auto text-status-warn h-6 px-2" onClick={() => refreshMutation.mutate()} disabled={isRefreshing} data-testid="btn-retry-recompute">
            <RefreshCw className="w-3 h-3 mr-1" />
            Retry
          </Button>
        </div>
      );
    }
    return null;
  };

  const renderLoadingState = () => {
    if (summaryLoading) {
      return <McuContentSkeleton />;
    }
    if ((computeStatus === "computing" || computeStatus === "idle") && (!marketAreaSummaries || marketAreaSummaries.length === 0)) {
      return (
        <div className="text-center py-12 max-w-md mx-auto">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-primary" />
          <p className="text-foreground font-medium text-lg mb-1">Preparing market data</p>
          <p className="text-muted-foreground text-sm mb-4">{computeProgress || "This runs automatically in the background."}</p>
          {computePercent > 0 && (
            <div className="space-y-2">
              <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${computePercent}%` }} />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{computePercent}% complete</span>
                {computeEtaSeconds !== null && <span>{formatEta(computeEtaSeconds)}</span>}
              </div>
            </div>
          )}
        </div>
      );
    }
    if (computeStatus === "error" && (!marketAreaSummaries || marketAreaSummaries.length === 0)) {
      return (
        <div className="text-center py-12">
          <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-status-warn" />
          <p className="text-foreground font-medium text-lg mb-1">Unable to load market data</p>
          <p className="text-muted-foreground text-sm mb-4">{summaryResponse?.error || "An error occurred."}</p>
          <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate()} disabled={isRefreshing} data-testid="btn-retry-mcu">
            <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
            {isRefreshing ? "Retrying..." : "Try Again"}
          </Button>
        </div>
      );
    }
    return null;
  };

  const hasData = marketAreaSummaries && marketAreaSummaries.length > 0;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      <main className="max-w-7xl mx-auto p-4 sm:p-6">
        {/* Task #4369 — audit §7.3: the old full-width burgundy band here
            duplicated the global top nav; the shared PageHeader is the one
            page-level header now (back affordance + tokened title). */}
        <PageHeader
          title="MCU Capacity Dashboard"
          backHref="/"
          icon={Building2}
          className="mb-6"
        />
        <Tabs defaultValue="heatmap" className="space-y-6">
          {/* h-auto + flex-wrap: three icon+label triggers exceed 375px viewports;
              wrapping keeps every tab reachable without horizontal page scroll. */}
          <TabsList className="h-auto max-w-full flex-wrap bg-card border">
            <TabsTrigger value="heatmap" className="flex items-center gap-2" data-testid="tab-heatmap">
              <Globe className="w-4 h-4" />
              Market Heatmap
            </TabsTrigger>
            <TabsTrigger value="overview" className="flex items-center gap-2" data-testid="tab-overview">
              <BarChart3 className="w-4 h-4" />
              Market Overview
            </TabsTrigger>
            <TabsTrigger value="evaluate" className="flex items-center gap-2" data-testid="tab-evaluate">
              <Map className="w-4 h-4" />
              Evaluate Prospect
            </TabsTrigger>
          </TabsList>

          {/* ===== HEATMAP TAB ===== */}
          <TabsContent value="heatmap" className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl font-bold text-foreground">Market Capacity Heatmap</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedState
                    ? `Viewing ${STATE_NAMES[selectedState] || selectedState}`
                    : "Click a state to drill into local market zones"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {lastComputedAt && <span className="text-xs text-muted-foreground">Updated {new Date(lastComputedAt).toLocaleString()}</span>}
                {renderComputeStatus()}
                <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate()} disabled={isRefreshing} data-testid="btn-full-recompute-mcu" className="text-primary-ink border-primary/30 hover:bg-primary/5">
                  <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
                  Recompute
                </Button>
                <ConfirmActionDialog
                  trigger={
                    <Button variant="outline" size="sm" disabled={isRefreshing} data-testid="btn-deep-recompute-mcu">
                      Deep Rescan
                    </Button>
                  }
                  title="Run a deep rescan?"
                  description="This clears all cached competitor data (radii and probe cache) and recomputes from scratch. It takes 30+ minutes, during which capacity numbers may be incomplete."
                  confirmLabel="Deep Rescan"
                  onConfirm={() => refreshMutation.mutate({ clearRadii: true, clearProbeCache: true })}
                  testId="dialog-deep-recompute-mcu"
                />
              </div>
            </div>

            {renderLoadingState() || (hasData && (
              <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
                {/* Sidebar Filters */}
                <div className="xl:col-span-1 space-y-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-semibold text-foreground">Filters</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <Label className="text-xs font-medium text-muted-foreground">State</Label>
                        <Select value={stateFilter} onValueChange={(v) => { setStateFilter(v); setSelectedState(null); setSelectedMarketArea(null); }}>
                          <SelectTrigger data-testid="select-state-filter"><SelectValue placeholder="All states" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_all">All States</SelectItem>
                            {US_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs font-medium text-muted-foreground">Practice Area</Label>
                        <Select value={practiceFilter} onValueChange={setPracticeFilter}>
                          <SelectTrigger data-testid="select-practice-filter"><SelectValue placeholder="All practices" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_all">All Practices</SelectItem>
                            {practiceAreas?.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs font-medium text-muted-foreground mb-2 block">Capacity Status</Label>
                        <div className="space-y-2">
                          {CAPACITY_STATUS_LEGEND.map(({ key, colorKey, label }) => (
                            <label key={key} className="flex items-center gap-2 cursor-pointer text-sm" data-testid={`filter-status-${key.toLowerCase()}`}>
                              <Checkbox checked={statusFilters.has(key)} onCheckedChange={() => toggleStatusFilter(key)} />
                              <span
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: CAPACITY_STATUS_COLORS[colorKey] }}
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                </div>

                {/* Main Content Area */}
                <div className="xl:col-span-3 space-y-6">
                  {/* Map */}
                  {!selectedMarketArea && !selectedState && (
                    <Card>
                      <CardContent className="p-4">
                        <UsStateMap
                          stateData={stateDataForMap}
                          selectedState={selectedState}
                          onStateClick={(st) => {
                            if (st === selectedState) {
                              setSelectedState(null);
                              setSelectedMarketArea(null);
                            } else {
                              setSelectedState(st);
                              setSelectedMarketArea(null);
                            }
                          }}
                          onStateHover={setHoveredState}
                          hoveredState={hoveredState}
                        />
                      </CardContent>
                    </Card>
                  )}

                  {/* State Zoom Map */}
                  {selectedState && !selectedMarketArea && (
                    <Card>
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setSelectedState(null); setSelectedMarketArea(null); }}
                            data-testid="btn-back-to-national"
                          >
                            <ArrowLeft className="w-4 h-4 mr-1" />
                            Back to National Map
                          </Button>
                        </div>
                        <HexGridMap
                          stateAbbr={selectedState}
                          stateName={STATE_NAMES[selectedState] || selectedState}
                          practiceArea={practiceFilter}
                          onMarketAreaClick={(id) => setSelectedMarketArea(id)}
                        />
                      </CardContent>
                    </Card>
                  )}


                  {/* Market Area Detail View */}
                  {selectedArea && (
                    <div className="space-y-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedMarketArea(null)}
                        data-testid="btn-back-to-zones"
                      >
                        <ArrowLeft className="w-4 h-4 mr-1" />
                        Back to {selectedState} map
                      </Button>

                      {/* Market Area Info Box */}
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-foreground text-xl">{selectedArea.marketAreaName}</CardTitle>
                          <CardDescription>{selectedArea.state} · Local Market Zone</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">
                                <MetricTooltip label="Local Competitive Range (R2)">
                                  <p>Where competition is locally dense enough to matter. Based on density drop-off analysis, not raw distance.</p>
                                  {selectedArea.radiusDiagnostics && (
                                    <div className="mt-2 text-left space-y-1">
                                      <p><strong>Competitors analyzed:</strong> {selectedArea.radiusDiagnostics.competitorsAnalyzed}</p>
                                      <p><strong>R2 base:</strong> {selectedArea.radiusDiagnostics.r2Base} mi</p>
                                      {selectedArea.radiusDiagnostics.densityCore != null && <p><strong>Core density (1mi):</strong> {selectedArea.radiusDiagnostics.densityCore.toFixed(1)}/sqmi</p>}
                                      {selectedArea.radiusDiagnostics.isDense != null && <p><strong>Dense market:</strong> {selectedArea.radiusDiagnostics.isDense ? "Yes" : "No"}</p>}
                                      {selectedArea.radiusDiagnostics.popDensity3mi != null && <p><strong>Pop density (3mi):</strong> {selectedArea.radiusDiagnostics.popDensity3mi.toLocaleString()}/sqmi</p>}
                                      {selectedArea.radiusDiagnostics.popFactor != null && <p><strong>Pop factor:</strong> {selectedArea.radiusDiagnostics.popFactor}x</p>}
                                      {selectedArea.radiusDiagnostics.rMarket != null && <p><strong>R_market:</strong> {selectedArea.radiusDiagnostics.rMarket} mi</p>}
                                      {selectedArea.radiusDiagnostics.competitorsWithin20mi != null && <p><strong>Competitors within 20mi:</strong> {selectedArea.radiusDiagnostics.competitorsWithin20mi}</p>}
                                    </div>
                                  )}
                                </MetricTooltip>
                              </div>
                              <div className="font-bold text-xl text-foreground">{selectedArea.r2Radius ? `${selectedArea.r2Radius} mi` : "N/A"}</div>
                            </div>
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">Local Zone Population</div>
                              <div className="font-bold text-xl text-foreground">
                                {selectedArea.practices.reduce((s, p) => s + (p.marketPopulation || 0), 0).toLocaleString()}
                              </div>
                            </div>
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">Competitors in Zone</div>
                              <div className="font-bold text-xl text-foreground">
                                {selectedArea.practices.reduce((s, p) => s + (p.competitorsInZone || 0), 0).toLocaleString()}
                              </div>
                            </div>
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">
                                <MetricTooltip label="Market Envelope">
                                  <p>The metro-level radius used to define the total addressable market. Walks outward until 2M population is captured, ensuring a meaningful capacity denominator.</p>
                                </MetricTooltip>
                              </div>
                              <div className="font-bold text-xl text-foreground">{selectedArea.rMarketRadius ? `${selectedArea.rMarketRadius} mi` : "N/A"}</div>
                            </div>
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">
                                <MetricTooltip label="Pack Opportunity">
                                  <p>Total Google Local Pack slots available across all cells in the market envelope (3 slots per cell). MCU% = used slots / total slots.</p>
                                </MetricTooltip>
                              </div>
                              <div className="font-bold text-xl text-foreground">
                                {selectedArea.practices.reduce((s, p) => s + (p.totalOpportunity || 0), 0).toLocaleString()}
                              </div>
                            </div>
                            <div className="bg-surface-warm-2 rounded-lg p-3 text-center">
                              <div className="text-xs text-muted-foreground">Eff. Clients</div>
                              <div className="font-bold text-xl text-foreground">{selectedArea.clientCount}</div>
                            </div>
                          </div>

                          {/* Practice Breakdown Table */}
                          <h4 className="text-sm font-semibold text-foreground mb-3">Practice Area Capacity</h4>
                          <div className="space-y-3">
                            {(practiceFilter !== "_all" ? selectedArea.practices.filter(p => p.practiceArea === practiceFilter) : selectedArea.practices).map((practice) => {
                              const barColor = practice.statusColor === "green" ? "bg-status-ok"
                                : practice.statusColor === "yellow" ? "bg-status-warn/60"
                                : practice.statusColor === "orange" ? "bg-status-warn"
                                : "bg-status-critical";
                              const remainingPct = 100 - Math.min(100, practice.capacityUsedPercent);

                              return (
                                <div key={practice.practiceArea} className="bg-card border border-border rounded-lg p-3" data-testid={`practice-detail-${practice.practiceArea}`}>
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="font-medium text-foreground">{practice.practiceArea}</span>
                                    <div className="flex items-center gap-2">
                                      <Badge className={`text-xs border ${getOverlapRiskBadge(practice.overlapRisk)}`} data-testid={`overlap-risk-${practice.practiceArea}`}>
                                        <MetricTooltip label={`${practice.overlapRisk} Overlap`}>
                                          <p>Indicates territory overlap between client locations. High overlap means multiple clients compete in the same area.</p>
                                        </MetricTooltip>
                                      </Badge>
                                      <Badge className={`text-xs ${practice.statusColor === "green" ? "bg-status-ok/10 text-status-ok" : practice.statusColor === "yellow" ? "bg-status-warn/10 text-status-warn" : practice.statusColor === "orange" ? "bg-status-warn/20 text-status-warn" : "bg-status-critical/10 text-status-critical"}`}>
                                        {practice.status}
                                      </Badge>
                                    </div>
                                  </div>
                                  <div className="space-y-1.5">
                                    <div>
                                      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
                                        <MetricTooltip label="Capacity Used">
                                          <p>Percentage of the market's total capacity allocated to active clients in this practice area.</p>
                                        </MetricTooltip>
                                        <span className="font-semibold text-foreground">{practice.capacityUsedPercent}%</span>
                                      </div>
                                      <div className="bg-muted rounded-full h-2.5 overflow-hidden">
                                        <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, practice.capacityUsedPercent)}%` }} />
                                      </div>
                                    </div>
                                    <div>
                                      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
                                        <span>Remaining Capacity</span>
                                        <span className="font-semibold text-status-ok">{remainingPct}%</span>
                                      </div>
                                      <div className="bg-muted rounded-full h-2.5 overflow-hidden">
                                        <div className="h-full bg-status-ok/70 transition-all" style={{ width: `${remainingPct}%` }} />
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                                    <span>Pop: {(practice.marketPopulation || 0).toLocaleString()}</span>
                                    <span>Competitors: {practice.competitorsInZone ?? "?"}</span>
                                    <span>Clients: {practice.uniqueClients || "?"}</span>
                                    {practice.strongInfluenceRadius != null && (
                                      <MetricTooltip label="Strong Influence">
                                        <p>The radius where occupancy weight is still meaningful (w &ge; 0.20). Beyond this distance, a location's influence fades to near zero.</p>
                                      </MetricTooltip>
                                    )}
                                    {practice.strongInfluenceRadius != null && (
                                      <span className="text-foreground">{practice.strongInfluenceRadius} mi</span>
                                    )}
                                    {practice.rMarket != null && (
                                      <span className="text-foreground">R_market: {practice.rMarket} mi</span>
                                    )}
                                    {practice.totalOpportunity != null && (
                                      <span>Pack slots: {practice.usedOpportunity?.toLocaleString() || 0} / {practice.totalOpportunity.toLocaleString()}</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                      </Card>

                      {/* Locations */}
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-sm font-semibold text-foreground">Locations in this Zone</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="bg-card rounded border overflow-x-auto">
                            <table className="w-full text-sm min-w-[560px]">
                              <thead>
                                <tr className="border-b bg-surface-warm-2">
                                  <th className="text-left p-3 font-medium text-muted-foreground">Client</th>
                                  <th className="text-left p-3 font-medium text-muted-foreground">Address</th>
                                  <th className="text-left p-3 font-medium text-muted-foreground">Practices</th>
                                </tr>
                              </thead>
                              <tbody>
                                {selectedArea.locations.map((loc) => (
                                  <tr key={loc.locationId} className="border-b last:border-b-0 hover:bg-surface-warm-2">
                                    <td className="p-3 font-medium">{loc.clientName}</td>
                                    <td className="p-3 text-muted-foreground">{loc.address}</td>
                                    <td className="p-3 text-muted-foreground">{loc.practiceAreas.join(", ")}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </CardContent>
                      </Card>

                      {/* Top Overlaps */}
                      {selectedArea.topExternalOverlaps.length > 0 && (
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm font-semibold text-foreground">
                              <MetricTooltip label="Top Client Territory Overlaps">
                                <p>Shows which clients have the most territorial overlap in this market zone. High overlap can cause internal conflicts and reduced performance.</p>
                              </MetricTooltip>
                            </CardTitle>
                          </CardHeader>
                          <CardContent>
                            <div className="bg-card rounded border overflow-x-auto">
                              <table className="w-full text-sm min-w-[480px]">
                                <thead>
                                  <tr className="border-b bg-surface-warm-2">
                                    <th className="text-left p-3 font-medium text-muted-foreground">Client</th>
                                    <th className="text-left p-3 font-medium text-muted-foreground">Address</th>
                                    <th className="text-right p-3 font-medium text-muted-foreground">Overlap</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {selectedArea.topExternalOverlaps.map((ext, idx) => (
                                    <tr key={idx} className="border-b last:border-b-0 hover:bg-surface-warm-2">
                                      <td className="p-3 font-medium">{ext.clientName}</td>
                                      <td className="p-3 text-muted-foreground">{ext.address}</td>
                                      <td className="p-3 text-right">
                                        <Badge variant="outline" className={`text-xs ${ext.overlapPercent > 50 ? "text-status-critical border-status-critical/40" : ext.overlapPercent > 25 ? "text-status-warn border-status-warn/40" : "text-status-ok border-status-ok/40"}`}>
                                          {ext.overlapPercent}%
                                        </Badge>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  )}

                  {/* No state selected: show all market areas summary */}
                  {!selectedState && hasData && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm font-semibold text-foreground">All Local Market Zones</CardTitle>
                        <CardDescription>Click a state on the map or select a zone below to drill down</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {Object.entries(stateRollups)
                          .filter(([, r]) => statusFilters.has(r.status))
                          .sort((a, b) => b[1].capacityUsedPercent - a[1].capacityUsedPercent)
                          .map(([st, rollup]) => {
                            const barColor = rollup.statusColor === "green" ? "bg-status-ok" : rollup.statusColor === "yellow" ? "bg-status-warn/60" : rollup.statusColor === "orange" ? "bg-status-warn" : "bg-status-critical";
                            return (
                              <div
                                key={st}
                                className="flex items-center gap-3 p-3 bg-card rounded-lg border border-border cursor-pointer hover:border-primary/40 transition-all"
                                onClick={() => { setSelectedState(st); setSelectedMarketArea(null); }}
                                data-testid={`state-row-${st}`}
                              >
                                <span className="font-bold text-foreground w-8">{st}</span>
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 bg-muted rounded-full h-2 overflow-hidden">
                                      <div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, rollup.capacityUsedPercent)}%` }} />
                                    </div>
                                    <span className="text-sm font-bold w-10 text-right">{rollup.capacityUsedPercent}%</span>
                                  </div>
                                </div>
                                <span className="text-xs text-muted-foreground">{rollup.marketAreaCount} zone{rollup.marketAreaCount !== 1 ? "s" : ""}</span>
                                <ArrowRight className="w-4 h-4 text-muted-foreground" />
                              </div>
                            );
                          })}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </div>
            ))}
          </TabsContent>

          {/* ===== OVERVIEW TAB (existing list view) ===== */}
          <TabsContent value="overview" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-foreground">Market Saturation by Region</CardTitle>
                    <CardDescription>Filter by state and practice area to see capacity status</CardDescription>
                  </div>
                  <div className="flex items-center gap-3">
                    {lastComputedAt && <span className="text-xs text-muted-foreground">Updated {new Date(lastComputedAt).toLocaleString()}</span>}
                    {renderComputeStatus()}
                    <Button variant="outline" size="sm" onClick={() => refreshMutation.mutate()} disabled={isRefreshing} data-testid="btn-full-recompute-mcu-overview" className="text-primary-ink border-primary/30 hover:bg-primary/5">
                      <RefreshCw className={`w-4 h-4 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
                      Recompute
                    </Button>
                    <ConfirmActionDialog
                      trigger={
                        <Button variant="outline" size="sm" disabled={isRefreshing} data-testid="btn-deep-recompute-mcu-overview">
                          Deep Rescan
                        </Button>
                      }
                      title="Run a deep rescan?"
                      description="This clears all cached competitor data (radii and probe cache) and recomputes from scratch. It takes 30+ minutes, during which capacity numbers may be incomplete."
                      confirmLabel="Deep Rescan"
                      onConfirm={() => refreshMutation.mutate({ clearRadii: true, clearProbeCache: true })}
                      testId="dialog-deep-recompute-mcu-overview"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-4 mb-6">
                  <div className="w-40">
                    <Label>State</Label>
                    <Select value={stateFilter} onValueChange={setStateFilter}>
                      <SelectTrigger><SelectValue placeholder="All states" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_all">All States</SelectItem>
                        {US_STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-48">
                    <Label>Practice Area</Label>
                    <Select value={practiceFilter} onValueChange={setPracticeFilter}>
                      <SelectTrigger><SelectValue placeholder="All practices" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="_all">All Practices</SelectItem>
                        {practiceAreas?.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {renderLoadingState() || (hasData && (
                  <div className="space-y-4">
                    {marketAreaSummaries!.map((area, i) => {
                      const practices = practiceFilter !== "_all" ? area.practices.filter(p => p.practiceArea === practiceFilter) : area.practices;
                      if (practices.length === 0) return null;

                      return (
                        <div key={area.marketAreaId} className="bg-card rounded-lg border border-border overflow-hidden" data-testid={`market-area-${i}`}>
                          <div className="p-4">
                            <div className="font-semibold text-lg text-foreground">
                              {area.marketAreaName}
                              {(area.r2Radius || area.rMarketRadius) ? ` (` : ''}
                              {area.r2Radius ? `R2: ${area.r2Radius} mi` : ''}
                              {area.rMarketRadius ? `${area.r2Radius ? ' · ' : ''}R_mkt: ${area.rMarketRadius} mi` : ''}
                              {area.radiusDiagnostics?.competitorsAnalyzed ? ` · ${area.radiusDiagnostics.competitorsAnalyzed} competitors` : ''}
                              {(area.r2Radius || area.rMarketRadius) ? ')' : ''}
                            </div>
                            <div className="text-sm text-muted-foreground">{area.state} · {area.locationCount} location{area.locationCount !== 1 ? 's' : ''}</div>
                          </div>
                          <div className="px-4 pb-4 overflow-x-auto">
                            <table className="w-full text-sm min-w-[480px]">
                              <thead>
                                <tr className="border-b border-border">
                                  <th className="text-left py-2 font-medium text-muted-foreground">Practice</th>
                                  <th className="text-left py-2 font-medium text-muted-foreground w-1/2">Capacity Used</th>
                                  <th className="text-left py-2 font-medium text-muted-foreground">Status</th>
                                  <th className="text-left py-2 font-medium text-muted-foreground">Overlap</th>
                                </tr>
                              </thead>
                              <tbody>
                                {practices.map((practice) => {
                                  const barColor = practice.statusColor === "green" ? "bg-status-ok"
                                    : practice.statusColor === "yellow" ? "bg-status-warn/60"
                                    : practice.statusColor === "orange" ? "bg-status-warn"
                                    : "bg-status-critical";
                                  const statusBg = practice.statusColor === "green" ? "bg-status-ok/10 text-status-ok"
                                    : practice.statusColor === "yellow" ? "bg-status-warn/10 text-status-warn"
                                    : practice.statusColor === "orange" ? "bg-status-warn/20 text-status-warn"
                                    : "bg-status-critical/10 text-status-critical";

                                  return (
                                    <tr key={practice.practiceArea} className="border-b border-border last:border-b-0">
                                      <td className="py-3">{practice.practiceArea}</td>
                                      <td className="py-3">
                                        <div className="flex items-center gap-3">
                                          <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden" title={`Pop: ${practice.marketPopulation?.toLocaleString() || '?'} · Competitors: ${practice.competitorsInZone ?? '?'} · Clients: ${practice.uniqueClients || '?'} · Pack slots: ${practice.usedOpportunity?.toLocaleString() || '?'} / ${practice.totalOpportunity?.toLocaleString() || '?'}`}>
                                            <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, practice.capacityUsedPercent)}%` }} />
                                          </div>
                                          <span className="font-bold text-foreground w-12 text-right">{practice.capacityUsedPercent}%</span>
                                        </div>
                                      </td>
                                      <td className="py-3"><Badge className={`text-xs ${statusBg}`}>{practice.status}</Badge></td>
                                      <td className="py-3"><Badge className={`text-xs border ${getOverlapRiskBadge(practice.overlapRisk)}`}>{practice.overlapRisk}</Badge></td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== EVALUATE PROSPECT TAB ===== */}
          <TabsContent value="evaluate" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-foreground">Evaluate Prospect</CardTitle>
                  <CardDescription>Get detailed capacity analysis with client overlap information</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <Label>Practice Area</Label>
                    <Select value={practiceArea} onValueChange={setPracticeArea}>
                      <SelectTrigger data-testid="select-eval-practice"><SelectValue placeholder="Select practice area" /></SelectTrigger>
                      <SelectContent>
                        {practiceAreas?.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Addresses (one per line)</Label>
                    <Textarea value={addressesText} onChange={(e) => setAddressesText(e.target.value)} placeholder="123 Main St, Dallas, TX 75201" className="min-h-[100px]" data-testid="input-eval-addresses" />
                  </div>
                  <Button onClick={handleEvaluate} disabled={!practiceArea || !addressesText.trim() || evaluateMutation.isPending} className="w-full bg-primary hover:bg-primary/90" data-testid="button-internal-evaluate">
                    {evaluateMutation.isPending ? "Evaluating..." : "Evaluate Prospect"}
                  </Button>
                </CardContent>
              </Card>

              {results && results.length > 0 && (
                <div className="space-y-4">
                  {results.map((result, index) => {
                    const verdictConfig = getVerdictConfig(result.verdict);
                    const VerdictIcon = verdictConfig.icon;
                    const statusColors: Record<string, string> = {
                      green: "bg-status-ok",
                      yellow: "bg-status-warn/60",
                      orange: "bg-status-warn",
                      red: "bg-status-critical",
                    };
                    const currentBarColor = statusColors[result.currentStatusColor] || "bg-muted-foreground/40";
                    const projectedBarColor = statusColors[result.projectedStatusColor] || "bg-muted-foreground/40";
                    return (
                      <Card key={index} className={`border-2 ${verdictConfig.bg}`} data-testid={`internal-result-${index}`}>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-start gap-2">
                              <MapPin className="w-4 h-4 text-primary mt-1" />
                              <div>
                                <p className="font-medium text-foreground">{result.address}</p>
                                {result.marketAreaName && <p className="text-xs text-muted-foreground">Market: {result.marketAreaName}</p>}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <VerdictIcon className={`w-5 h-5 ${verdictConfig.color}`} />
                              <span className={`font-bold ${verdictConfig.color}`}>{result.verdict.toUpperCase()}</span>
                            </div>
                          </div>

                          <p className="text-sm text-foreground mb-4">{result.narrative}</p>

                          <div className="mb-4 space-y-3">
                            <div>
                              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                                <span>Current Capacity</span>
                                <span className="font-semibold">{Math.round(result.currentCapacityUsedPercent)}% — {result.currentStatus}</span>
                              </div>
                              <div className="w-full bg-muted rounded-full h-2.5">
                                <div className={`h-2.5 rounded-full ${currentBarColor} transition-all`} style={{ width: `${Math.min(result.currentCapacityUsedPercent, 100)}%` }} />
                              </div>
                            </div>

                            <div>
                              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                                <span>Projected (with prospect)</span>
                                <span className="font-semibold">
                                  {Math.round(result.projectedCapacityUsedPercent)}% — {result.projectedStatus}
                                  {result.deltaCapacityPercent > 0 && (
                                    <span className="text-status-critical ml-1">(+{Math.round(result.deltaCapacityPercent)})</span>
                                  )}
                                </span>
                              </div>
                              <div className="w-full bg-muted rounded-full h-2.5">
                                <div className={`h-2.5 rounded-full ${projectedBarColor} transition-all`} style={{ width: `${Math.min(result.projectedCapacityUsedPercent, 100)}%` }} />
                              </div>
                            </div>

                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>Overlap Risk: <strong>{result.overlapRisk}</strong></span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                            <div className="bg-muted/60 rounded p-2">
                              <div className="font-bold text-lg">{result.existingClientCount}</div>
                              <div className="text-xs text-muted-foreground">Our Clients</div>
                            </div>
                            <div className="bg-muted/60 rounded p-2">
                              <div className="font-bold text-lg">{result.competitorsInZone}</div>
                              <div className="text-xs text-muted-foreground">Competitors</div>
                            </div>
                            <div className="bg-muted/60 rounded p-2">
                              <div className="font-bold text-lg">{result.prospectR2 ? `${result.prospectR2}mi` : "—"}</div>
                              <div className="text-xs text-muted-foreground">Prospect R2</div>
                            </div>
                            <div className="bg-muted/60 rounded p-2">
                              <div className="font-bold text-lg">{result.rMarket ? `${result.rMarket}mi` : "—"}</div>
                              <div className="text-xs text-muted-foreground">Market Radius</div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
