import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  LineChart, Line, CartesianGrid, Legend, Area, AreaChart,
} from "recharts";
import {
  TrendingUp, MapPin, Activity, Settings,
  RefreshCw, CheckCircle, XCircle, AlertTriangle,
  ArrowUpRight, Loader2, ChevronsUpDown, Check, Plus, X, Link2, Zap,
} from "lucide-react";
import InteractiveHeatmap from "./InteractiveHeatmap";
import { SEMRUSH_SYNC_POLL_INTERVAL_MS, SEMRUSH_SYNC_MAX_POLLS } from "@/lib/constants";
import { LocalDominanceSyncStatePanel } from "./LocalDominanceSyncStatePanel";
import { MarketShareLeaderboard as SharedMarketShareLeaderboard } from "./MarketShareLeaderboard";
import { HEATMAP_DISTRIBUTION_BAND_COLORS } from "@shared/heatmapColors";
import { svgSafeId } from "@/lib/svgSafeId";

interface LocalDominanceDashboardProps {
  clientId: string;
  userRole?: string;
}

interface CompetitorEntry {
  rank: number;
  name: string;
  shareOfVoice: number;
  averageRank: number | null;
  reviewCount: number | null;
  reviewRating: number | null;
  isSubjectBusiness: boolean;
  locationLabel: string | null;
}


interface IntegrationConfig {
  id: string;
  clientId: string;
  integrationEnabled: boolean;
  semrushCampaignId: string | null;
  businessName: string | null;
  businessLocationId: string | null;
  defaultGridSize: string;
  syncStatus: string;
  lastSuccessfulSyncAt: string | null;
  lastFailedSyncAt: string | null;
  errorMessage: string | null;
  warningMessage: string | null;
  lastSyncOutcome: string | null;
  lastSyncSummary: string | null;
  syncProgress: string | null;
  isActive: boolean;
}

interface ClientLocation {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
}

interface SemrushCampaign {
  id: string;
  businessName: string;
  campaignName?: string;
  address?: string;
  location?: string;
  keywords?: Array<{ id: string; name: string; status: string }>;
}

interface LocationCampaignMapping {
  id: string;
  clientId: string;
  locationId: string;
  semrushCampaignId: string;
  semrushCampaignName: string | null;
  isStale: boolean;
  staleSince: string | null;
}

interface LocationMetrics {
  avgRank: number | null;
  bestRank: number | null;
  top3Coverage: number | null;
  top10Coverage: number | null;
  sov90dAvg: number | null;
  anchorIncrease: number | null;
  bandTop3Pct: number | null;
  band4to10Pct: number | null;
  band11to20Pct: number | null;
  bandOutOfTop20Pct: number | null;
}

interface LocationSnapshot {
  locationId: string;
  locationName: string;
  address: string | null;
  city: string | null;
  state: string | null;
  snapshotId: string | null;
  campaignId: string | null;
  keywordName: string | null;
  reportDate: string | null;
  shareOfVoice: number | null;
  avgRank: number | null;
  top3Coverage: number | null;
  availableKeywords: string[] | null;
  metrics: LocationMetrics | null;
  competitors: CompetitorEntry[];
  distributionBands: {
    bandTop3Pct: number;
    band4to10Pct: number;
    band11to20Pct: number;
    bandOutOfTop20Pct: number;
  } | null;
}

const BAND_COLORS = HEATMAP_DISTRIBUTION_BAND_COLORS;

const BAND_LABELS = {
  top3: "Top 3",
  band4to10: "4–10",
  band11to20: "11–20",
  outOfTop20: "Out of Top 20",
};

function LocationSovTrend({ clientId, campaignId, keyword }: { clientId: string; campaignId: string; keyword: string | null }) {
  const params = new URLSearchParams();
  if (keyword) params.set("keyword", keyword);
  params.set("campaignId", campaignId);
  const qs = params.toString();

  const { data: sovHistory } = useQuery<Array<{
    date: string;
    sovRaw: number;
    sov90dAvg: number | null;
    anchorIncrease: number | null;
  }>>({
    queryKey: ["/api/clients", clientId, "local-dominance", "sov-history", campaignId, keyword],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/local-dominance/sov-history?${qs}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  if (!sovHistory || sovHistory.length < 2) return null;

  return (
    <div className="border border-border rounded-lg p-4" data-testid={`loc-sov-trend-${campaignId}`}>
      <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5 mb-3">
        <TrendingUp className="w-3.5 h-3.5" />
        Map Coverage Trend
      </h4>
      <div className="h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={sovHistory} margin={{ top: 5, right: 15, left: 0, bottom: 5 }}>
            <defs>
              {/* Task #4430 — dynamic gradient ids sanitize via svgSafeId or an
                  invalid url(#id) paint renders the area OPAQUE BLACK. */}
              <linearGradient id={`sovGrad-${svgSafeId(campaignId)}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.5)" />
            <XAxis dataKey="date" fontSize={10} tickFormatter={d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} />
            <YAxis domain={[0, 'auto']} fontSize={10} tickFormatter={v => `${v}%`} />
            <Tooltip
              formatter={(value: number, name: string) => [
                `${value}%`,
                name === "sovRaw" ? "Raw Coverage" : "90-day Avg"
              ]}
              labelFormatter={d => new Date(d).toLocaleDateString()}
              contentStyle={{ borderRadius: 8, fontSize: 11 }}
            />
            <Area
              type="monotone"
              dataKey="sovRaw"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill={`url(#sovGrad-${svgSafeId(campaignId)})`}
              dot={{ r: 2, fill: "hsl(var(--primary))" }}
              name="Raw Coverage"
            />
            {sovHistory.some(h => h.sov90dAvg !== null) && (
              <Line
                type="monotone"
                dataKey="sov90dAvg"
                stroke="hsl(var(--status-warn))"
                strokeWidth={2}
                strokeDasharray="5 5"
                dot={false}
                name="90-day Avg"
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Exported for the Task #2223 regression test, which exercises the
// unmatched-location hint (enriching vs. genuinely-no-match branches) in
// isolation.
export function LocationCampaignPicker({
  location,
  campaigns,
  assignedCampaignIds,
  onAdd,
  onRemove,
  campaignsLoading,
  semrushConnected,
  semrushStatusResolved,
  semrushStatusError,
  campaignsError,
  isUnmatched,
  semrushEnriching,
  isRefreshing,
  onRefresh,
}: {
  location: ClientLocation;
  campaigns: SemrushCampaign[];
  assignedCampaignIds: Array<{ campaignId: string; campaignName: string | null; isStale?: boolean; staleSince?: string | null }>;
  onAdd: (campaignId: string, campaignName: string) => void;
  onRemove: (campaignId: string) => void;
  campaignsLoading: boolean;
  semrushConnected: boolean;
  semrushStatusResolved: boolean;
  semrushStatusError: boolean;
  campaignsError: boolean;
  isUnmatched?: boolean;
  semrushEnriching?: boolean;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const assignedIds = new Set(assignedCampaignIds.map(a => a.campaignId));

  return (
    <div className={`border rounded-lg p-3 ${isUnmatched ? "bg-amber-50 border-amber-300 ring-1 ring-amber-200" : "bg-card"}`} data-testid={`location-mapping-${location.id}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-foreground">{location.name}</p>
            {isUnmatched && (
              <Badge variant="outline" className="text-caption border-amber-400 text-amber-700 bg-amber-100 py-0 h-4 shrink-0" data-testid={`unmatched-badge-${location.id}`}>
                Needs matching
              </Badge>
            )}
          </div>
          {(location.address || location.city) && (
            <p className="text-xs text-muted-foreground">
              {[location.address, location.city, location.state].filter(Boolean).join(", ")}
            </p>
          )}
        </div>
        <Badge variant="outline" className="text-caption">
          {assignedCampaignIds.length} campaign{assignedCampaignIds.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {assignedCampaignIds.length > 0 && (
        <div className="space-y-1 mb-2">
          {assignedCampaignIds.map(({ campaignId, campaignName, isStale, staleSince }) => {
            const campaign = campaigns.find(c => c.id === campaignId);
            const keywordNames = campaign?.keywords?.map(k => k.name).join(", ");
            return (
              <div key={campaignId} className={`flex items-center justify-between rounded px-2 py-1.5 ${isStale ? "bg-red-50 border border-red-200" : "bg-primary/5"}`} data-testid={`assigned-campaign-${campaignId}`}>
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {isStale ? (
                      <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
                    ) : (
                      <Link2 className="w-3 h-3 text-primary shrink-0" />
                    )}
                    <span className={`text-xs font-medium truncate ${isStale ? "text-red-700" : ""}`}>{campaignName || campaign?.businessName || campaignId}</span>
                    {isStale && (
                      <Badge variant="outline" className="text-caption border-red-300 text-red-600 py-0 h-4 shrink-0" data-testid={`stale-badge-${campaignId}`}>
                        Stale
                      </Badge>
                    )}
                  </div>
                  {isStale && staleSince && (
                    <span className="text-caption text-red-500 pl-[18px]">
                      Not found in SEMrush since {new Date(staleSince).toLocaleDateString()}
                    </span>
                  )}
                  {(keywordNames || campaign?.location || campaign?.address) && (
                    <div className="pl-[18px] flex flex-col gap-0">
                      {(campaign?.location || campaign?.address) && (
                        <span className="text-caption text-muted-foreground truncate flex items-center gap-0.5">
                          <MapPin className="w-2.5 h-2.5 shrink-0" />
                          {campaign.location || campaign.address}
                        </span>
                      )}
                      {keywordNames && (
                        <span className="text-caption text-muted-foreground truncate">Keyword: {keywordNames}</span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => onRemove(campaignId)}
                  className="text-muted-foreground hover:text-red-600 p-0.5 shrink-0"
                  data-testid={`remove-campaign-${campaignId}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {assignedCampaignIds.length < 1 && <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-full text-xs h-7 justify-start" data-testid={`add-campaign-${location.id}`}>
            <Plus className="w-3 h-3 mr-1" />
            Add campaign
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search campaigns..." data-testid="campaign-search-input" />
            <CommandList>
              <CommandEmpty>
                {!semrushStatusResolved && !semrushStatusError
                  ? "Checking SEMrush connection…"
                  : semrushStatusError
                  ? "Unable to check SEMrush connection. Please try again."
                  : !semrushConnected
                  ? "SEMrush is not connected — reconnect in the Integrations Hub."
                  : campaignsLoading
                  ? "Loading campaigns…"
                  : campaignsError
                  ? "Unable to load campaigns. Please try again."
                  : "No campaigns found."}
              </CommandEmpty>
              <CommandGroup>
                {campaigns
                  .filter(c => !assignedIds.has(c.id))
                  .map(c => (
                    <CommandItem
                      key={c.id}
                      value={`${c.businessName} ${c.campaignName || ""} ${c.location || ""} ${c.address || ""} ${c.keywords?.map(k => k.name).join(" ") || ""} ${c.id}`}
                      onSelect={() => {
                        onAdd(c.id, c.businessName);
                        setOpen(false);
                      }}
                      data-testid={`campaign-option-${c.id}`}
                      className="group"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-sm text-foreground group-data-[selected=true]:text-white">{c.businessName}</span>
                        {c.campaignName && (
                          <span className="text-caption text-muted-foreground group-data-[selected=true]:text-white/80 italic">Campaign: {c.campaignName}</span>
                        )}
                        {(c.location || c.address) && (
                          <span className="text-xs text-foreground group-data-[selected=true]:text-white/90 flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5 shrink-0" />
                            {c.location || c.address}
                          </span>
                        )}
                        {c.keywords && c.keywords.length > 0 && (
                          <span className="text-caption text-muted-foreground group-data-[selected=true]:text-white/80">
                            Keyword: {c.keywords.map(k => k.name).join(", ")}
                          </span>
                        )}
                        <span className="text-muted-foreground text-caption font-mono group-data-[selected=true]:text-white/70">ID: {c.id}</span>
                      </div>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>}

      {/* Task #2185: contextual empty-state for an unmatched location, so the
          "Needs matching" badge is never a silent dead end. Distinguishes
          still-loading from genuinely-no-match and offers the refresh action. */}
      {isUnmatched && assignedCampaignIds.length === 0 && (
        <p className="mt-2 text-caption text-amber-700" data-testid={`unmatched-hint-${location.id}`}>
          {semrushEnriching || isRefreshing
            ? "Still loading campaign details from SEMrush…"
            : campaigns.length === 0
            ? "No SEMrush campaigns are available to match — the list may be out of date."
            : "No campaign was auto-matched. Pick one above, or refresh if this location's campaign was just created in SEMrush."}
          {onRefresh && !semrushEnriching && !isRefreshing && (
            <button
              type="button"
              onClick={onRefresh}
              className="ml-1 underline font-medium hover:text-amber-900"
              data-testid={`btn-refresh-campaigns-inline-${location.id}`}
            >
              Refresh campaigns from SEMrush
            </button>
          )}
        </p>
      )}
    </div>
  );
}

// Task #1966 — the Market Share Leaderboard surfaces a per-row GBP location
// label whenever the same firm name appears more than once in a market's
// shown set, so duplicates are visibly distinct. The rendering now lives in
// the shared `MarketShareLeaderboard` component (Task #2028) so the in-app
// dashboard and the public/printable report can't drift apart. This thin
// wrapper preserves the dashboard's `{ locationId, competitors }` signature
// (and the exported name used by the regression test).
export function MarketShareLeaderboard({
  locationId,
  competitors,
}: {
  locationId: string;
  competitors: CompetitorEntry[];
}) {
  return (
    <SharedMarketShareLeaderboard
      idKey={locationId}
      competitors={competitors}
      variant="dashboard"
    />
  );
}

export default function LocalDominanceDashboard({ clientId, userRole }: LocalDominanceDashboardProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showConfig, setShowConfig] = useState(false);
  const [localMappings, setLocalMappings] = useState<Array<{
    locationId: string;
    semrushCampaignId: string;
    semrushCampaignName: string | null;
    isStale?: boolean;
    staleSince?: string | null;
  }>>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [selectedKeyword, setSelectedKeyword] = useState<string | null>(null);

  const isAdmin = userRole === "ceo" || userRole === "team_lead" || userRole === "account_manager";

  const { data: integration } = useQuery<IntegrationConfig | null>({
    queryKey: ["/api/clients", clientId, "semrush-integration"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/clients/${clientId}/semrush-integration`, { credentials: "include", signal });
      if (!res.ok) return null;
      return res.json();
    },
    staleTime: 60_000,
  });

  const { data: locations } = useQuery<ClientLocation[]>({
    queryKey: ["/api/clients", clientId, "locations"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/locations`, { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    },
    enabled: showConfig && isAdmin,
  });

  const { data: existingMappings } = useQuery<LocationCampaignMapping[]>({
    queryKey: ["/api/clients", clientId, "semrush-location-campaigns"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/semrush-location-campaigns`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const { data: semrushStatus, isSuccess: semrushStatusResolved, isError: semrushStatusError } = useQuery<{ connected: boolean; expired: boolean }>({
    queryKey: ["/api/semrush/status"],
    queryFn: async () => {
      const res = await fetch("/api/semrush/status", { credentials: "include" });
      if (!res.ok) throw new Error(`Status check failed (HTTP ${res.status})`);
      return res.json();
    },
    enabled: showConfig && isAdmin,
    staleTime: 60_000,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * (attemptIndex + 1), 3000),
  });
  const semrushConnected = semrushStatus?.connected ?? false;
  const semrushExpired = semrushStatusResolved && !!semrushStatus?.expired;
  const semrushDisconnected = semrushStatusResolved && !semrushStatus?.connected && !semrushStatus?.expired;
  // Task #2630 — the global status query has neither resolved nor errored yet.
  // While checking we must never imply the global integration is down: the
  // default `connected ?? false` is a loading placeholder, not a real state.
  const semrushStatusChecking = !semrushStatusResolved && !semrushStatusError;

  const { data: campaignsResult, isLoading: campaignsLoading, isError: campaignsIsError, failureCount: campaignsFailureCount, error: campaignsError } = useQuery<{
    enriching: boolean;
    campaigns: SemrushCampaign[];
  }>({
    queryKey: ["semrush-campaigns"],
    queryFn: async () => {
      const res = await fetch("/api/semrush/campaigns", { credentials: "include" });
      if (!res.ok) {
        try {
          const body = await res.json();
          throw new Error(body?.error || `HTTP ${res.status}`);
        } catch (e: any) {
          if (e instanceof Error && e.message !== `HTTP ${res.status}`) throw e;
          throw new Error(`Failed to load campaigns (HTTP ${res.status})`);
        }
      }
      const data = await res.json();
      const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : Array.isArray(data) ? data : [];
      if (data?.status === "enriching") {
        return { enriching: true, campaigns };
      }
      return { enriching: false, campaigns };
    },
    enabled: showConfig && isAdmin && semrushConnected,
    staleTime: 60_000,
    refetchInterval: (query) => {
      if (query.state.data?.enriching) return 10000;
      return false;
    },
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * (attemptIndex + 1), 5000),
  });
  const semrushCampaigns = campaignsResult?.campaigns || [];
  const semrushEnriching = campaignsResult?.enriching ?? false;

  useEffect(() => {
    if (existingMappings && showConfig) {
      setLocalMappings(existingMappings.map(m => ({
        locationId: m.locationId,
        semrushCampaignId: m.semrushCampaignId,
        semrushCampaignName: m.semrushCampaignName,
        isStale: m.isStale,
        staleSince: m.staleSince,
      })));
      setHasChanges(false);
    }
  }, [existingMappings, showConfig]);

  const { data: availableKeywords } = useQuery<Array<{ keyword: string; campaignId: string }>>({
    queryKey: ["/api/clients", clientId, "local-dominance", "keywords"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/local-dominance/keywords`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => {
    if (availableKeywords && availableKeywords.length > 0 && selectedKeyword === null) {
      setSelectedKeyword(availableKeywords[0].keyword);
    }
  }, [availableKeywords, selectedKeyword]);

  useEffect(() => {
    if (!availableKeywords || availableKeywords.length <= 1) return;
    for (const kw of availableKeywords) {
      if (kw.keyword === selectedKeyword) continue;
      const kwParam = `?keyword=${encodeURIComponent(kw.keyword)}`;
      void queryClient.prefetchQuery({ // fire-and-forget: prefetch only
        queryKey: ["/api/clients", clientId, "local-dominance", "location-snapshots", kw.keyword],
        queryFn: async () => {
          const res = await fetch(`/api/clients/${clientId}/local-dominance/location-snapshots${kwParam}`, { credentials: "include" });
          if (!res.ok) return [];
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [availableKeywords, selectedKeyword, clientId, queryClient]);

  const keywordParam = selectedKeyword ? `?keyword=${encodeURIComponent(selectedKeyword)}` : "";

  const { data: locationSnapshots, isLoading: dashboardLoading } = useQuery<LocationSnapshot[]>({
    queryKey: ["/api/clients", clientId, "local-dominance", "location-snapshots", selectedKeyword],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/local-dominance/location-snapshots${keywordParam}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (!locationSnapshots) return;
    for (const loc of locationSnapshots) {
      if (!loc.snapshotId) continue;
      void queryClient.prefetchQuery({ // fire-and-forget: prefetch only
        queryKey: ["/api/heatmaps", loc.snapshotId, "geojson"],
        queryFn: async () => {
          const res = await fetch(`/api/heatmaps/${loc.snapshotId}/geojson?mode=rank`, { credentials: "include" });
          if (!res.ok) throw new Error("Failed");
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [locationSnapshots, queryClient]);

  const saveMappings = useMutation({
    mutationFn: async (mappings: typeof localMappings) => {
      const res = await fetch(`/api/clients/${clientId}/semrush-location-campaigns`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ mappings }),
      });
      if (!res.ok) throw new Error("Failed to save");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-location-campaigns"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-integration"] }); // fire-and-forget: cache refresh only
      toast({ title: "Campaign mappings saved", description: "Pulling data from SEMrush..." });
      setHasChanges(false);
      setShowConfig(false);
      syncNow.mutate();
    },
    onError: (err: any) => {
      toast({ title: "Failed to save mappings", description: err.message, variant: "destructive" });
    },
  });

  const autoMatchAttempted = useRef(false);
  const [unmatchedLocationIds, setUnmatchedLocationIds] = useState<string[]>([]);
  const autoMatchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/semrush-location-campaigns/auto-match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ autoSave: true }),
      });
      if (res.status === 202) {
        const body = await res.json();
        throw new Error(body?.message || "Campaign enrichment still in progress. Please try again shortly.");
      }
      if (!res.ok) {
        let msg = "Auto-match failed";
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    retry: 2,
    retryDelay: 5000,
    onSuccess: (data: { matched: any[]; unmatched: string[]; message: string }) => {
      setUnmatchedLocationIds(data.unmatched || []);
      if (data.matched.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-location-campaigns"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-integration"] }); // fire-and-forget: cache refresh only
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "local-dominance"] }); // fire-and-forget: cache refresh only
        toast({
          title: "Auto-matched campaigns",
          description: data.unmatched.length > 0
            ? `${data.message}. ${data.unmatched.length} location${data.unmatched.length !== 1 ? "s" : ""} need manual matching.`
            : data.message,
        });
        syncNow.mutate();
        if (data.unmatched.length > 0) {
          setShowConfig(true);
        }
      } else if (data.unmatched.length > 0) {
        toast({
          title: "Campaign matching needed",
          description: "Could not auto-match locations — please configure manually.",
        });
        setShowConfig(true);
      }
    },
    onError: (err: any) => {
      toast({ title: "Auto-match failed", description: err.message || "Please try again or configure manually.", variant: "destructive" });
    },
  });

  // Task #2185: force a cache-bypassing re-fetch of the SEMrush campaign list
  // so brand-new campaigns become available immediately, then re-run auto-match
  // against the fresh list. Used by the "Refresh campaigns from SEMrush"
  // control and the empty-state recovery action.
  const refreshCampaignsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/semrush/campaigns/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      if (!res.ok) {
        let msg = "Failed to refresh campaigns";
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {}
        throw new Error(msg);
      }
      return res.json() as Promise<{ status: string; campaigns: SemrushCampaign[]; count: number }>;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["semrush-campaigns"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Campaigns refreshed",
        description: `${data.count} campaign${data.count !== 1 ? "s" : ""} loaded from SEMrush. Re-running auto-match...`,
      });
      // Cache is now fresh, so a plain auto-match runs against the new list.
      autoMatchAttempted.current = false;
      autoMatchMutation.mutate();
    },
    onError: (err: any) => {
      toast({
        title: "Couldn't refresh campaigns",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const campaignsReady = semrushConnected && !semrushEnriching && !campaignsLoading && !campaignsIsError && !!campaignsResult;

  // Destructured so the effect depends on the stable `mutate` fn and the
  // primitive pending flag instead of the mutation object (whose identity
  // changes every state transition).
  const { mutate: runAutoMatch, isPending: autoMatchPending } = autoMatchMutation;
  useEffect(() => {
    if (
      !autoMatchAttempted.current &&
      isAdmin &&
      existingMappings &&
      existingMappings.length === 0 &&
      !autoMatchPending &&
      campaignsReady
    ) {
      autoMatchAttempted.current = true;
      runAutoMatch();
    }
    // The `autoMatchAttempted` ref guard makes re-runs (e.g. when
    // `autoMatchPending` flips back to false) no-ops.
  }, [existingMappings, isAdmin, campaignsReady, autoMatchPending, runAutoMatch]);

  const [isSyncPolling, setIsSyncPolling] = useState(false);
  const pollingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    pollingRef.current = false;
    setIsSyncPolling(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const pollSyncStatus = useCallback(async () => {
    if (pollingRef.current) return;
    if (!clientId) return;
    pollingRef.current = true;
    setIsSyncPolling(true);
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    for (let i = 0; i < SEMRUSH_SYNC_MAX_POLLS; i++) {
      if (signal.aborted) return;
      if (document.visibilityState === "hidden") {
        await new Promise<void>((resolve) => {
          const onVisible = () => {
            if (document.visibilityState === "visible") {
              document.removeEventListener("visibilitychange", onVisible);
              resolve();
            }
          };
          document.addEventListener("visibilitychange", onVisible);
          signal.addEventListener("abort", () => {
            document.removeEventListener("visibilitychange", onVisible);
            resolve();
          }, { once: true });
        });
        if (signal.aborted) return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SEMRUSH_SYNC_POLL_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (signal.aborted) return;
      try {
        const res = await fetch(`/api/clients/${clientId}/semrush-integration`, { credentials: "include", signal });
        if (!res.ok) continue;
        const data = await res.json();
        if (data) {
          queryClient.setQueryData(["/api/clients", clientId, "semrush-integration"], data);
        }
        if (!data || data.syncStatus !== "syncing") {
          void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId] }); // fire-and-forget: cache refresh only
          stopPolling();
          if (data?.syncStatus === "success") {
            toast({ title: "Sync complete", description: "SEMrush data synced successfully" });
          } else if (data?.syncStatus === "error") {
            const msg = data.errorMessage || "Sync failed";
            const isStaleError = msg.toLowerCase().includes("stale") || msg.toLowerCase().includes("no longer found") || msg.toLowerCase().includes("no longer exists");
            toast({
              title: isStaleError ? "SEMrush campaign issue" : "SEMrush sync failed",
              description: msg,
              variant: "destructive",
            });
            if (isStaleError) {
              void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-location-campaigns"] }); // fire-and-forget: cache refresh only
            }
          }
          return;
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    stopPolling();
    void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-integration"] }); // fire-and-forget: cache refresh only
    toast({ title: "Sync timeout", description: "Sync is taking longer than expected. Check back later.", variant: "destructive" });
  }, [clientId, queryClient, toast, stopPolling]);

  useEffect(() => {
    if (!clientId) stopPolling();
    return () => { stopPolling(); };
  }, [clientId, stopPolling]);

  const syncNow = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/semrush-integration/sync`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Sync failed");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-integration"] }); // fire-and-forget: cache refresh only
      toast({ title: "Sync started", description: "Pulling data from SEMrush in the background..." });
      void pollSyncStatus(); // fire-and-forget: background polling, errors handled inside
    },
    onError: (err: any) => {
      const msg = err.message || "Sync failed";
      const isStaleError = msg.toLowerCase().includes("stale") || msg.toLowerCase().includes("no longer found") || msg.toLowerCase().includes("no longer exists");
      toast({
        title: isStaleError ? "SEMrush campaign issue" : "SEMrush sync failed",
        description: msg,
        variant: "destructive",
      });
      if (isStaleError) {
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "semrush-location-campaigns"] }); // fire-and-forget: cache refresh only
      }
    },
  });

  // Placed after `syncNow` so its deps can be listed without a TDZ read.
  // `pollSyncStatus` no-ops while a poll is already in flight (pollingRef),
  // so re-runs from `isSyncPolling` / `isPending` flips are safe.
  useEffect(() => {
    if (integration?.syncStatus === "syncing" && !isSyncPolling && !syncNow.isPending) {
      void pollSyncStatus(); // fire-and-forget: background polling, errors handled inside
    }
  }, [integration?.syncStatus, isSyncPolling, pollSyncStatus, syncNow.isPending]);

  const handleAddCampaign = (locationId: string, campaignId: string, campaignName: string) => {
    const already = localMappings.some(m => m.locationId === locationId && m.semrushCampaignId === campaignId);
    if (already) return;
    setLocalMappings(prev => [...prev, { locationId, semrushCampaignId: campaignId, semrushCampaignName: campaignName }]);
    setHasChanges(true);
  };

  const handleRemoveCampaign = (locationId: string, campaignId: string) => {
    setLocalMappings(prev => prev.filter(m => !(m.locationId === locationId && m.semrushCampaignId === campaignId)));
    setHasChanges(true);
  };

  const hasData = locationSnapshots && locationSnapshots.length > 0 && locationSnapshots.some(l => l.snapshotId);
  const totalMappings = existingMappings?.length || 0;

  return (
    <div className="space-y-6" data-testid="local-dominance-dashboard">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2" data-testid="dashboard-title">
            <MapPin className="w-5 h-5" />
            Local Dominance Dashboard
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Local search visibility, competitor positioning, and ranking distribution
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowConfig(!showConfig)}
                data-testid="btn-configure-integration"
              >
                <Settings className="w-4 h-4 mr-1" />
                Configure
                {totalMappings > 0 && (
                  <Badge variant="secondary" className="ml-1.5 text-caption px-1.5 py-0">{totalMappings}</Badge>
                )}
              </Button>
              {totalMappings > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => syncNow.mutate()}
                  disabled={syncNow.isPending || isSyncPolling || integration?.syncStatus === "syncing"}
                  data-testid="btn-sync-now"
                >
                  {syncNow.isPending || isSyncPolling || integration?.syncStatus === "syncing" ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="w-4 h-4 mr-1" />
                  )}
                  {isSyncPolling || integration?.syncStatus === "syncing" ? "Syncing..." : "Sync Now"}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {integration && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground" data-testid="sync-status-bar">
          {integration.syncStatus === "success" && (() => {
            const outcome = integration.lastSyncOutcome ?? "success";
            const summary = integration.lastSyncSummary;
            const truncatedSummary = summary
              ? (summary.length > 80 ? summary.substring(0, 80) + "…" : summary)
              : null;
            if (outcome === "already_current") {
              return (
                <Badge
                  variant="outline"
                  className="border-sky-500 text-sky-700"
                  title={summary || "Data already current"}
                  data-testid="badge-sync-already-current"
                >
                  <CheckCircle className="w-3 h-3 mr-1" />
                  {truncatedSummary
                    ? `Already current: ${truncatedSummary}`
                    : "Already current"}
                </Badge>
              );
            }
            if (outcome === "partial_success") {
              return (
                <Badge
                  variant="outline"
                  className="border-amber-500 text-amber-700"
                  title={summary || integration.warningMessage || "Partially refreshed"}
                  data-testid="badge-sync-partial"
                >
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  {truncatedSummary
                    ? `Partially refreshed: ${truncatedSummary}`
                    : "Partially refreshed"}
                </Badge>
              );
            }
            return (
              <Badge
                variant="outline"
                className="border-green-500 text-green-700"
                title={summary || undefined}
                data-testid="badge-sync-fresh"
              >
                <CheckCircle className="w-3 h-3 mr-1" />
                {truncatedSummary
                  ? `Freshly synced: ${truncatedSummary}`
                  : "Freshly synced"}
              </Badge>
            );
          })()}
          {integration.syncStatus === "error" && (
            <Badge variant="outline" className="border-red-500 text-red-700" title={integration.errorMessage || undefined} data-testid="badge-sync-error">
              <XCircle className="w-3 h-3 mr-1" /> {integration.errorMessage ? `Sync failed: ${integration.errorMessage.length > 80 ? integration.errorMessage.substring(0, 80) + "…" : integration.errorMessage}` : "Last sync failed"}
            </Badge>
          )}
          {integration.syncStatus !== "error"
            && integration.lastSyncOutcome !== "partial_success"
            && integration.warningMessage && (
            <Badge variant="outline" className="border-amber-500 text-amber-700" title={integration.warningMessage} data-testid="badge-sync-warning">
              <AlertTriangle className="w-3 h-3 mr-1" /> {`Sync warning: ${integration.warningMessage.length > 80 ? integration.warningMessage.substring(0, 80) + "…" : integration.warningMessage}`}
            </Badge>
          )}
          {integration.syncStatus === "syncing" && (
            <Badge variant="outline" className="border-blue-500 text-blue-700">
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              {(() => {
                try {
                  if (integration.syncProgress) {
                    const p = JSON.parse(integration.syncProgress);
                    if (p.totalLocations > 1) {
                      return `Syncing location ${p.currentLocation}/${p.totalLocations} — keyword ${p.currentKeyword}/${p.totalKeywords}`;
                    }
                    return `Syncing keyword ${p.currentKeyword} of ${p.totalKeywords}`;
                  }
                } catch {}
                return "Syncing...";
              })()}
            </Badge>
          )}
          {integration.lastSuccessfulSyncAt && (
            <span>Last synced: {new Date(integration.lastSuccessfulSyncAt).toLocaleDateString()}</span>
          )}
        </div>
      )}

      {(() => {
        const staleMappings = existingMappings?.filter(m => m.isStale) || [];
        const totalMappingsCount = existingMappings?.length || 0;
        if (staleMappings.length > 0) {
          return (
            <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3" data-testid="stale-campaigns-warning">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">
                  {staleMappings.length} of {totalMappingsCount} campaign{totalMappingsCount !== 1 ? "s" : ""} could not be found in SEMrush. Please reconfigure in Settings.
                </p>
                <p className="text-xs text-amber-600 mt-0.5">
                  {staleMappings.map(m => m.semrushCampaignName || m.semrushCampaignId).join(", ")}
                </p>
              </div>
            </div>
          );
        }
        return null;
      })()}

      <LocalDominanceSyncStatePanel
        clientId={clientId}
        canRetry={userRole === "account_manager" || userRole === "admin"}
      />

      {availableKeywords && availableKeywords.length > 1 && (
        <div className="flex items-center gap-3" data-testid="global-keyword-selector">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Keyword:</span>
          <div className="flex flex-wrap gap-1.5">
            {availableKeywords.map(kw => (
              <button
                key={kw.keyword}
                onClick={() => setSelectedKeyword(kw.keyword)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all border ${
                  selectedKeyword === kw.keyword
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-card text-muted-foreground border-border hover:border-primary/40 hover:text-primary-ink"
                }`}
                data-testid={`keyword-select-${kw.keyword.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {kw.keyword}
              </button>
            ))}
          </div>
        </div>
      )}

      {showConfig && isAdmin && (
        <Card className="border-primary/20" data-testid="config-panel">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-foreground">Semrush Campaign Mapping</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Assign Semrush campaigns to each client location. Each campaign represents one business location and can track multiple keywords.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Task #2630 — neutral state while the global status query is still
                resolving. Never imply the integration is down before we know. */}
            {semrushStatusChecking && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3" data-testid="semrush-checking">
                <Loader2 className="w-4 h-4 shrink-0 animate-spin" />
                Checking SEMrush connection…
              </div>
            )}

            {semrushExpired && (
              <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg p-3" data-testid="semrush-expired">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Your SEMrush session has expired — please re-authorize in the Integrations Hub.
              </div>
            )}

            {/* Task #2630 — genuine global outage only: shown once the status
                query has resolved and reports disconnected. Points operators to
                the global Integrations Hub, not a per-client setting. */}
            {semrushDisconnected && (
              <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg p-3" data-testid="semrush-not-connected">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                SEMrush is not connected — reconnect in the Integrations Hub.
              </div>
            )}

            {semrushStatusError && (
              <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-3" data-testid="semrush-status-error">
                <XCircle className="w-4 h-4 shrink-0" />
                Unable to check SEMrush connection status. Please try again.
              </div>
            )}

            {/* Task #2630 — global integration is up but this client has no
                campaigns mapped yet. This is a setup state, not an outage, so
                keep it neutral and client-scoped. Gated on the account having
                campaigns to map (the zero-account-campaigns case is handled by
                the dedicated empty-state below). */}
            {semrushConnected
              && integration?.syncStatus !== "syncing"
              && semrushCampaigns.length > 0
              && (existingMappings?.length ?? 0) === 0 && (
              <div className="flex items-center gap-2 text-sm text-sky-700 bg-sky-50 border border-sky-200 rounded-lg p-3" data-testid="semrush-client-not-configured">
                <Settings className="w-4 h-4 shrink-0" />
                SEMrush is connected, but this client isn't set up yet. Map a campaign to each location below, then save to sync.
              </div>
            )}

            {semrushConnected && campaignsIsError && (
              <div className="flex items-center gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-3" data-testid="semrush-error">
                <XCircle className="w-4 h-4 shrink-0" />
                {campaignsError?.message || "Unable to load campaigns from Semrush. Please try again."}
              </div>
            )}

            {campaignsLoading && semrushCampaigns.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" />
                {campaignsFailureCount > 0
                  ? `Retrying campaign load (attempt ${campaignsFailureCount + 1}/3)...`
                  : "Loading campaigns from Semrush..."}
              </div>
            )}

            {semrushEnriching && semrushCampaigns.length > 0 && (
              <div className="flex items-center gap-1.5 text-caption text-muted-foreground/70 py-0.5 justify-center">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Updating campaign details...
              </div>
            )}

            {/* Task #2185: explicit empty-state when SEMrush is connected and
                healthy but no campaigns came back. The list may simply be
                out of date (e.g. campaigns created in SEMrush after the last
                background refresh), so offer the cache-bypassing refresh
                instead of a silent dead end. */}
            {semrushConnected && !campaignsLoading && !campaignsIsError && !semrushEnriching && semrushCampaigns.length === 0 && (
              <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3" data-testid="no-campaigns-empty-state">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <div>
                    <p className="font-medium">No SEMrush campaigns found yet.</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      If you just created campaigns in SEMrush, the list may be out of date. Refresh to pull the latest campaigns directly from SEMrush.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refreshCampaignsMutation.mutate()}
                    disabled={refreshCampaignsMutation.isPending}
                    data-testid="btn-refresh-campaigns-empty"
                  >
                    {refreshCampaignsMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                    Refresh campaigns from SEMrush
                  </Button>
                </div>
              </div>
            )}

            {locations && locations.length === 0 && (
              <div className="text-sm text-muted-foreground bg-muted/50 rounded-lg p-4 text-center" data-testid="no-locations">
                No locations found for this client. Add locations first to map campaigns.
              </div>
            )}

            {locations && locations.length > 0 && (
              <div className="space-y-2">
                {locations.filter(l => l.id).map(location => (
                  <LocationCampaignPicker
                    key={location.id}
                    location={location}
                    campaigns={semrushCampaigns}
                    assignedCampaignIds={localMappings
                      .filter(m => m.locationId === location.id)
                      .map(m => ({
                        campaignId: m.semrushCampaignId,
                        campaignName: m.semrushCampaignName,
                        isStale: m.isStale || false,
                        staleSince: m.staleSince || null,
                      }))}
                    onAdd={(campaignId, campaignName) => handleAddCampaign(location.id, campaignId, campaignName)}
                    onRemove={(campaignId) => handleRemoveCampaign(location.id, campaignId)}
                    campaignsLoading={campaignsLoading}
                    semrushConnected={semrushConnected}
                    semrushStatusResolved={semrushStatusResolved}
                    semrushStatusError={semrushStatusError}
                    campaignsError={campaignsIsError}
                    isUnmatched={unmatchedLocationIds.includes(location.id)}
                    semrushEnriching={semrushEnriching}
                    isRefreshing={refreshCampaignsMutation.isPending}
                    onRefresh={() => refreshCampaignsMutation.mutate()}
                  />
                ))}
              </div>
            )}

            <div className="flex justify-between gap-2 pt-2 border-t">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { autoMatchAttempted.current = false; autoMatchMutation.mutate(); }}
                  disabled={autoMatchMutation.isPending || refreshCampaignsMutation.isPending || semrushEnriching}
                  data-testid="btn-auto-match"
                >
                  {autoMatchMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Zap className="w-4 h-4 mr-1" />}
                  Auto-match
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refreshCampaignsMutation.mutate()}
                  disabled={refreshCampaignsMutation.isPending || autoMatchMutation.isPending || !semrushConnected}
                  title="Re-fetch the latest campaigns from SEMrush (including ones just created), then re-run auto-match"
                  data-testid="btn-refresh-campaigns"
                >
                  {refreshCampaignsMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                  Refresh campaigns from SEMrush
                </Button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowConfig(false)}>Cancel</Button>
                <Button
                  size="sm"
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  onClick={() => saveMappings.mutate(localMappings)}
                  disabled={saveMappings.isPending || !hasChanges}
                  data-testid="btn-save-mappings"
                >
                  {saveMappings.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                  Save Mappings
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {dashboardLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (syncNow.isPending || isSyncPolling || integration?.syncStatus === "syncing") && !hasData ? (
        <Card className="border-dashed border-primary/20">
          <CardContent className="py-12 text-center" data-testid="syncing-state">
            <Loader2 className="w-12 h-12 mx-auto mb-4 text-primary animate-spin" />
            <h3 className="text-lg font-medium text-muted-foreground mb-2">Pulling data from SEMrush...</h3>
            {(() => {
              try {
                if (integration?.syncProgress) {
                  const p = JSON.parse(integration.syncProgress);
                  return (
                    <p className="text-sm font-medium text-muted-foreground mb-1" data-testid="sync-progress-detail">
                      {p.totalLocations > 1
                        ? `Location ${p.currentLocation} of ${p.totalLocations} — Keyword ${p.currentKeyword} of ${p.totalKeywords}`
                        : `Keyword ${p.currentKeyword} of ${p.totalKeywords}`}
                      {p.keywordName ? ` ("${p.keywordName}")` : ""}
                    </p>
                  );
                }
              } catch {}
              return null;
            })()}
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              This may take a moment. Your dashboard will update automatically once the sync is complete.
            </p>
          </CardContent>
        </Card>
      ) : !hasData ? (
        <Card className="border-dashed border-primary/20">
          <CardContent className="py-12 text-center">
            <MapPin className="w-12 h-12 mx-auto mb-4 text-primary/30" />
            <h3 className="text-lg font-medium text-muted-foreground mb-2" data-testid="empty-state-title">No Local Dominance Data Yet</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Configure the Semrush integration and sync data to see visibility metrics, competitor analysis, and ranking distribution.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8" data-testid="location-sections-container">
          {locationSnapshots!.map((loc) => {
            const locMetrics = loc.metrics;
            const locBands = loc.distributionBands;
            const locCompetitors = loc.competitors || [];
            const locDistData = locBands ? [
              { name: "Top 3", value: locBands.bandTop3Pct, color: BAND_COLORS.top3 },
              { name: "4–10", value: locBands.band4to10Pct, color: BAND_COLORS.band4to10 },
              { name: "11–20", value: locBands.band11to20Pct, color: BAND_COLORS.band11to20 },
              { name: "Out of Top 20", value: locBands.bandOutOfTop20Pct, color: BAND_COLORS.outOfTop20 },
            ] : [];
            const addressParts = [loc.address, loc.city, loc.state].filter(Boolean).join(", ");

            if (!loc.snapshotId) {
              return (
                <Card key={loc.locationId} className="border-primary/10 overflow-hidden" data-testid={`location-section-${loc.locationId}`}>
                  <div className="bg-gradient-to-r from-primary to-primary/75 px-5 py-3">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-white/80" />
                      <h3 className="text-base font-semibold text-white">{loc.locationName}</h3>
                    </div>
                    {addressParts && <p className="text-xs text-white/60 ml-6">{addressParts}</p>}
                  </div>
                  <CardContent className="py-8">
                    <div className="text-center text-sm text-muted-foreground" data-testid={`no-data-${loc.locationId}`}>
                      <p>This keyword is not tracked for this location's Semrush campaign.</p>
                      {loc.availableKeywords && loc.availableKeywords.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs text-muted-foreground mb-1.5">Available keywords for this location:</p>
                          <div className="flex flex-wrap justify-center gap-1.5">
                            {loc.availableKeywords.map(kw => (
                              <button
                                key={kw}
                                className="text-xs px-2.5 py-1 rounded-full bg-muted hover:bg-primary/10 hover:text-primary-ink transition-colors cursor-pointer"
                                onClick={() => setSelectedKeyword(kw)}
                                data-testid={`available-keyword-${kw}`}
                              >
                                {kw}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            }

            return (
              <Card key={loc.locationId} className="border-primary/10 overflow-hidden" data-testid={`location-section-${loc.locationId}`}>
                <div className="bg-gradient-to-r from-primary to-primary/75 px-5 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-white/80" />
                      <h3 className="text-base font-semibold text-white">{loc.locationName}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {loc.keywordName && (
                        <Badge className="bg-white/15 text-white border-white/20 text-caption">{loc.keywordName}</Badge>
                      )}
                      {loc.reportDate && (
                        <span className="text-caption text-white/50">Updated {loc.reportDate}</span>
                      )}
                    </div>
                  </div>
                  {addressParts && <p className="text-xs text-white/60 ml-6">{addressParts}</p>}
                </div>

                <CardContent className="p-5 space-y-5">
                  <div className="space-y-4">
                    <div>
                      <p className="text-caption font-semibold text-muted-foreground uppercase tracking-wider mb-2">Your Map Performance</p>
                      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
                        <div className="bg-muted/50 rounded-lg p-3" data-testid={`loc-sov-${loc.locationId}`}>
                          <p className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Map Coverage</p>
                          <div className="flex items-baseline gap-1.5 mt-1">
                            <p className="text-xl font-bold text-foreground">
                              {locMetrics?.sov90dAvg != null
                                ? `${locMetrics.sov90dAvg}%`
                                : loc.shareOfVoice != null
                                ? `${loc.shareOfVoice.toFixed(1)}%`
                                : "—"}
                            </p>
                            {locMetrics?.anchorIncrease != null && locMetrics.anchorIncrease > 0 && (
                              <Badge className="bg-green-100 text-green-800 border-green-300 text-caption font-semibold py-0 h-5">
                                <ArrowUpRight className="w-2.5 h-2.5 mr-0.5" />+{locMetrics.anchorIncrease}
                              </Badge>
                            )}
                          </div>
                          <p className="text-caption text-muted-foreground">
                            {locMetrics?.sov90dAvg != null
                              ? `You appear in ${locMetrics.sov90dAvg}% of all tracked locations`
                              : loc.shareOfVoice != null
                              ? `You appear in ${loc.shareOfVoice.toFixed(1)}% of all tracked locations`
                              : "Coverage data pending"}
                          </p>
                        </div>

                        <div className="bg-muted/50 rounded-lg p-3" data-testid={`loc-rank-${loc.locationId}`}>
                          <p className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Average Rank</p>
                          <p className="text-xl font-bold text-foreground mt-1">
                            {locMetrics?.avgRank != null ? `#${locMetrics.avgRank}` : loc.avgRank != null ? `#${loc.avgRank}` : "—"}
                          </p>
                          <p className="text-caption text-muted-foreground">
                            Best: {locMetrics?.bestRank != null ? `#${locMetrics.bestRank}` : "—"}
                          </p>
                        </div>

                        <div className="bg-muted/50 rounded-lg p-3" data-testid={`loc-top3-${loc.locationId}`}>
                          <p className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Top 3 Coverage</p>
                          <p className="text-xl font-bold text-foreground mt-1">
                            {locMetrics?.top3Coverage != null
                              ? `${locMetrics.top3Coverage}%`
                              : loc.top3Coverage != null
                              ? `${loc.top3Coverage}%`
                              : "—"}
                          </p>
                          <p className="text-caption text-muted-foreground">
                            Top 10: {locMetrics?.top10Coverage != null ? `${locMetrics.top10Coverage}%` : "—"}
                          </p>
                        </div>

                        <div className="bg-muted/50 rounded-lg p-3" data-testid={`loc-best-${loc.locationId}`}>
                          <p className="text-caption font-medium text-muted-foreground uppercase tracking-wide">Best Rank</p>
                          <p className="text-xl font-bold text-foreground mt-1">
                            {locMetrics?.bestRank != null ? `#${locMetrics.bestRank}` : "—"}
                          </p>
                          <p className="text-caption text-muted-foreground">grid point</p>
                        </div>
                      </div>
                    </div>

                    {(() => {
                      const coverageVal = locMetrics?.sov90dAvg ?? (loc.shareOfVoice != null ? Number(loc.shareOfVoice.toFixed(1)) : null);
                      const subjectBiz = locCompetitors.find(c => c.isSubjectBusiness);
                      const marketShareVal = subjectBiz ? Number(subjectBiz.shareOfVoice).toFixed(1) : null;
                      if (coverageVal != null && marketShareVal != null) {
                        return (
                          <div className="bg-gradient-to-r from-primary/5 via-transparent to-primary/5 rounded-lg px-4 py-2.5 text-xs text-muted-foreground italic border border-primary/10" data-testid={`loc-translator-${loc.locationId}`}>
                            You show up in many locations ({coverageVal}% coverage), but that visibility is shared across many firms, giving you {marketShareVal}% of the total market.
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    {locBands && (
                      <div className="border border-border rounded-lg p-4" data-testid={`loc-distribution-${loc.locationId}`}>
                        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5 mb-3">
                          <Activity className="w-3.5 h-3.5" />
                          Ranking Distribution
                        </h4>
                        <div className="h-[140px]">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={locDistData} layout="vertical" margin={{ left: 65, right: 15 }}>
                              <XAxis type="number" domain={[0, 100]} tickFormatter={v => `${v}%`} fontSize={10} />
                              <YAxis type="category" dataKey="name" fontSize={10} tick={{ fill: 'hsl(var(--primary))' }} />
                              <Tooltip
                                formatter={(value: number) => [`${value}%`, "Grid Coverage"]}
                                contentStyle={{ borderRadius: 8, fontSize: 11 }}
                              />
                              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                                {locDistData.map((entry, i) => (
                                  <Cell key={i} fill={entry.color} />
                                ))}
                              </Bar>
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="flex gap-2 mt-2 justify-center flex-wrap">
                          {locDistData.map(d => (
                            <div key={d.name} className="flex items-center gap-1 text-caption">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: d.color }} />
                              <span className="text-muted-foreground">{d.name}: <span className="font-medium text-foreground">{d.value}%</span></span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <MarketShareLeaderboard locationId={loc.locationId} competitors={locCompetitors} />
                  </div>

                  {loc.campaignId && (
                    <LocationSovTrend
                      clientId={clientId}
                      campaignId={loc.campaignId}
                      keyword={selectedKeyword || loc.keywordName}
                    />
                  )}

                  <div data-testid={`loc-heatmap-${loc.locationId}`}>
                    <InteractiveHeatmap
                      snapshotId={loc.snapshotId}
                      locationName={loc.locationName}
                      keywordName={selectedKeyword || loc.keywordName || ""}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}

        </div>
      )}
    </div>
  );
}
