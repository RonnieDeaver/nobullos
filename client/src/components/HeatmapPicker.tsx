import React, { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Search, MapPin, Calendar, Grid3X3, Upload, Loader2, Check, ChevronRight, AlertCircle, Eye, Download, Building2, Key, ExternalLink, Layers } from "lucide-react";
import InteractiveHeatmap from "./InteractiveHeatmap";
import { apiRequest } from "@/lib/queryClient";
import { logActivity } from "@/hooks/use-activity-tracker";
import { Link } from "wouter";

interface HeatmapSnapshot {
  id: string;
  locationId: string;
  locationName: string;
  businessName?: string | null;
  clientName?: string | null;
  campaignId: string;
  keywordId?: string | null;
  keywordName: string;
  reportDate: string;
  businessLat: number;
  businessLng: number;
  gridTemplate: string;
  gridUnit: string;
  gridDistance: number;
  pointsNumber?: number | null;
  createdAt?: string | null;
  metrics?: {
    avgRank?: number | null;
    top3CoveragePct?: number | null;
    top10CoveragePct?: number | null;
    rankedPointsCount?: number | null;
    unrankedPointsCount?: number | null;
  };
}

interface SemrushCampaign {
  id: string;
  businessName?: string;
  name?: string;
  address?: string;
  location?: string;
  gridSettings?: { template: string; unit: string; distance: number };
  schedule?: string;
}

interface SemrushKeyword {
  id: string;
  name: string;
  status: string;
}

interface MappedCampaign {
  semrushCampaignId: string;
  semrushCampaignName: string | null;
  locationId: string;
  locationName: string | null;
  locationAddress: string | null;
  locationCity: string | null;
  locationState: string | null;
  businessName?: string;
  address?: string;
  gridSettings?: any;
}

interface HeatmapPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (snapshotIds: string[]) => void;
  locationName?: string;
  reportMonth?: string;
  clientId?: string;
  locationId?: string;
}

export default function HeatmapPicker({ open, onClose, onSelect, locationName, reportMonth, clientId, locationId }: HeatmapPickerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<string>("semrush");
  const [searchQuery, setSearchQuery] = useState(locationName || "");
  const [previewSnapshotId, setPreviewSnapshotId] = useState<string | null>(null);
  const [rawJsonInput, setRawJsonInput] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [selectedKeywordId, setSelectedKeywordId] = useState<string | null>(null);
  const [campaignSearch, setCampaignSearch] = useState(locationName || "");

  // Tracks whether the user explicitly pressed "Back to campaigns" so the
  // lone-campaign auto-select effect does not immediately re-select on the
  // same render cycle and render the button dead.  Reset whenever the dialog
  // opens (not closes) so the first-open convenience still works.
  const userWentBack = React.useRef(false);

  // Kept in sync with selectedCampaignId so mutation callbacks can compare
  // the campaign they were fired for against the *current* selection without
  // a stale closure.
  const selectedCampaignIdRef = React.useRef<string | null>(null);

  const [bulkFetchProgress, setBulkFetchProgress] = useState<{
    total: number;
    completed: number;
    current: string;
  } | null>(null);

  const [bulkFetchResults, setBulkFetchResults] = useState<Array<{
    snapshotId: string;
    keywordId: string;
    keywordName: string;
    pointCount: number;
  }> | null>(null);

  const { data: semrushStatus } = useQuery<{ configured: boolean; connected: boolean; expired: boolean }>({
    queryKey: ["/api/semrush/status"],
    enabled: open,
  });

  const { data: mappedData, isLoading: mappedLoading, error: mappedError } = useQuery<{ campaigns: MappedCampaign[]; semrushAvailable: boolean }>({
    queryKey: ["/api/clients", clientId, "semrush-mapped-campaigns"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/semrush-mapped-campaigns`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to load mapped campaigns (${res.status})`);
      }
      return res.json();
    },
    enabled: open && !!clientId && semrushStatus?.configured === true,
    retry: false,
  });

  const mappedCampaigns = mappedData?.campaigns;
  const semrushAvailableForMapped = mappedData?.semrushAvailable ?? true;

  const relevantMappedCampaigns = locationId && mappedCampaigns
    ? mappedCampaigns.filter(mc => mc.locationId === locationId)
    : mappedCampaigns || [];

  const hasMappedCampaigns = relevantMappedCampaigns.length > 0;

  // Task #1960: filter the visible "Client Campaigns" list by the same
  // search input so typing actually narrows what the user sees, instead
  // of only filtering the global "search all Semrush campaigns" dropdown
  // below it.
  const campaignSearchTokens = campaignSearch
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
  const filteredMappedCampaigns = campaignSearchTokens.length === 0
    ? relevantMappedCampaigns
    : relevantMappedCampaigns.filter(mc => {
        const haystack = [
          mc.businessName,
          mc.semrushCampaignName,
          mc.locationName,
          mc.address,
          mc.locationAddress,
          mc.locationCity,
          mc.locationState,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return campaignSearchTokens.every(t => haystack.includes(t));
      });

  // Keep the ref in sync so mutation callbacks (whose closures are stale by
  // the time they fire) can still read the live selected campaign.
  useEffect(() => {
    selectedCampaignIdRef.current = selectedCampaignId;
  }, [selectedCampaignId]);

  // Reset the "user went back" flag each time the dialog opens so the
  // lone-campaign convenience auto-select still fires on first open.
  useEffect(() => {
    if (open) {
      userWentBack.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !mappedCampaigns || selectedCampaignId) return;
    // Never auto-select if the user explicitly navigated back — that would
    // make the "← Back to campaigns" button appear completely dead.
    if (userWentBack.current) return;
    const relevant = locationId
      ? mappedCampaigns.filter(mc => mc.locationId === locationId)
      : mappedCampaigns;
    const uniqueIds = [...new Set(relevant.map(mc => mc.semrushCampaignId))];
    if (uniqueIds.length === 1) {
      setSelectedCampaignId(uniqueIds[0]);
    }
  }, [open, mappedCampaigns, locationId, selectedCampaignId]);

  const [showGlobalSearch, setShowGlobalSearch] = useState(false);


  const { data: campaigns, isLoading: campaignsLoading, error: campaignsError } = useQuery<SemrushCampaign[]>({
    queryKey: ["/api/semrush/campaigns", campaignSearch],
    queryFn: async () => {
      const q = campaignSearch ? `?q=${encodeURIComponent(campaignSearch)}` : "";
      const res = await fetch(`/api/semrush/campaigns${q}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch campaigns (${res.status})`);
      }
      const data = await res.json();
      if (data?.status === "enriching") return [];
      return Array.isArray(data?.campaigns) ? data.campaigns : Array.isArray(data) ? data : [];
    },
    enabled: open && semrushStatus?.configured === true && (!hasMappedCampaigns || showGlobalSearch),
    retry: false,
  });

  const { data: keywords, isLoading: keywordsLoading, error: keywordsError } = useQuery<SemrushKeyword[]>({
    queryKey: ["/api/semrush/campaigns", selectedCampaignId, "keywords"],
    queryFn: async () => {
      const res = await fetch(`/api/semrush/campaigns/${selectedCampaignId}/keywords`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch keywords (${res.status})`);
      }
      return res.json();
    },
    enabled: !!selectedCampaignId,
    retry: false,
  });

  const [fetchResult, setFetchResult] = useState<{
    snapshotId: string;
    pointCount: number;
    semrushReportDate: string;
    dateMatchType: string;
  } | null>(null);

  // Task #2493: a brand-new Map Rank campaign that hasn't run its first
  // scheduled scan returns a distinct `no_report_dates_yet` signal (HTTP 422)
  // rather than a generic failure. Surface it as a clear "no scans yet" notice
  // that steers the operator to manual screenshot upload.
  const [noScansInfo, setNoScansInfo] = useState<{
    message: string;
    nextReportDate: string | null;
    frequency: string | null;
  } | null>(null);

  const fetchHeatmapMutation = useMutation({
    mutationFn: async ({ campaignId, keywordId }: { campaignId: string; keywordId: string }) => {
      const body: Record<string, any> = { keywordId };
      if (reportMonth) body.reportMonth = reportMonth;
      const res = await fetch(`/api/semrush/campaigns/${campaignId}/fetch-heatmap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422 && payload?.code === "no_report_dates_yet") {
          // Not a failure — a fresh campaign with no scans yet.
          return { __noScans: true, ...payload };
        }
        throw new Error(payload?.error || `${res.status}: request failed`);
      }
      return payload;
    },
    onSuccess: (data) => {
      if (data?.__noScans) {
        setFetchResult(null);
        setNoScansInfo({
          message: data.error,
          nextReportDate: data.campaignScheduling?.nextReportDate ?? null,
          frequency: data.campaignScheduling?.frequency ?? null,
        });
        logActivity("action", "Heatmap fetch — campaign has no scans yet", {
          nextReportDate: data.campaignScheduling?.nextReportDate ?? null,
        });
        return;
      }
      setNoScansInfo(null);
      logActivity("action", "Fetched heatmap data", { snapshotId: data.snapshotId, pointCount: data.pointCount });
      setFetchResult({
        snapshotId: data.snapshotId,
        pointCount: data.pointCount,
        semrushReportDate: data.semrushReportDate,
        dateMatchType: data.dateMatchType,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Fetch failed", description: err.message, variant: "destructive" });
    },
  });

  const fetchAllMutation = useMutation({
    mutationFn: async ({ campaignId }: { campaignId: string }) => {
      const body: Record<string, any> = {};
      if (reportMonth) body.reportMonth = reportMonth;
      const activeKws = keywords?.filter(kw => kw.status === "COLLECTED" || kw.status === "UNKNOWN") || [];
      setBulkFetchProgress({ total: activeKws.length, completed: 0, current: "Starting..." });
      const res = await apiRequest("POST", `/api/semrush/campaigns/${campaignId}/fetch-all-heatmaps`, body);
      return res.json();
    },
    onSuccess: (data, variables) => {
      // If the user pressed "Back to campaigns" while this fetch was in
      // flight, discard results silently — don't repopulate the campaign
      // view for a campaign the user already left.
      if (variables.campaignId !== selectedCampaignIdRef.current) {
        setBulkFetchProgress(null);
        return;
      }
      setBulkFetchProgress(null);
      setBulkFetchResults(data.results);
      if (data.errorCount > 0) {
        toast({
          title: `Fetched ${data.successCount} of ${data.totalKeywords} keywords`,
          description: `${data.errorCount} keyword(s) failed`,
          variant: "destructive",
        });
      } else {
        toast({
          title: `All ${data.successCount} heatmaps fetched`,
          description: `${data.results.reduce((s: number, r: any) => s + r.pointCount, 0)} total grid points imported`,
        });
      }
    },
    onError: (err: Error, variables) => {
      // Similarly, suppress the toast if the user already left this campaign.
      setBulkFetchProgress(null);
      if (variables.campaignId !== selectedCampaignIdRef.current) return;
      toast({ title: "Bulk fetch failed", description: err.message, variant: "destructive" });
    },
  });

  const [autoFetchTriggered, setAutoFetchTriggered] = useState<string | null>(null);

  // `autoFetchTriggered` marks each campaign as handled before the mutate
  // call, so re-runs from the extra dependencies (pending flag, results,
  // progress) can never double-fire the bulk fetch.
  const { mutate: fetchAllHeatmaps, isPending: fetchAllPending } = fetchAllMutation;
  useEffect(() => {
    if (!selectedCampaignId || !keywords || keywordsLoading) return;
    if (autoFetchTriggered === selectedCampaignId) return;
    if (fetchAllPending || bulkFetchResults || bulkFetchProgress) return;
    const activeKws = keywords.filter(kw => kw.status === "COLLECTED" || kw.status === "UNKNOWN");
    if (activeKws.length === 0) return;
    setAutoFetchTriggered(selectedCampaignId);
    fetchAllHeatmaps({ campaignId: selectedCampaignId });
  }, [
    selectedCampaignId,
    keywords,
    keywordsLoading,
    autoFetchTriggered,
    fetchAllPending,
    fetchAllHeatmaps,
    bulkFetchResults,
    bulkFetchProgress,
  ]);

  const { data: snapshots, isLoading: searchLoading } = useQuery<HeatmapSnapshot[]>({
    queryKey: ["/api/heatmaps/search", searchQuery],
    queryFn: async () => {
      const q = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : "";
      const res = await fetch(`/api/heatmaps/search${q}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to search heatmaps");
      return res.json();
    },
    enabled: open && activeTab === "browse",
  });

  const importMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await fetch("/api/heatmaps/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Import failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      logActivity("action", "Imported heatmap", { pointCount: data.pointCount });
      toast({ title: "Heatmap imported", description: `${data.pointCount} grid points imported successfully` });
      void queryClient.invalidateQueries({ queryKey: ["/api/heatmaps/search"] }); // fire-and-forget: cache refresh only
      setRawJsonInput("");
      setImportError(null);
      onSelect([data.snapshotId]);
      onClose();
    },
    onError: (err: Error) => {
      setImportError(err.message);
    },
  });

  const handleImportRawJson = useCallback(() => {
    setImportError(null);
    try {
      const parsed = JSON.parse(rawJsonInput);
      if (!parsed.locationId || !parsed.points) {
        setImportError("JSON must contain locationId and points array. See format below.");
        return;
      }
      importMutation.mutate(parsed);
    } catch (e) {
      setImportError("Invalid JSON format. Please paste valid Semrush heatmap data.");
    }
  }, [rawJsonInput, importMutation]);

  const handleSelectSnapshot = useCallback((snapshotId: string) => {
    onSelect([snapshotId]);
    onClose();
  }, [onSelect, onClose]);

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch { return dateStr; }
  };

  const selectedCampaign = campaigns?.find(c => c.id === selectedCampaignId);
  const selectedMappedCampaign = mappedCampaigns?.find(mc => mc.semrushCampaignId === selectedCampaignId);
  const selectedCampaignLabel = selectedCampaign?.businessName || selectedCampaign?.name || selectedMappedCampaign?.businessName || selectedMappedCampaign?.semrushCampaignName || "Campaign";
  const activeKeywords = keywords?.filter(kw => kw.status === "COLLECTED" || kw.status === "UNKNOWN") || [];

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { onClose(); setSelectedCampaignId(null); setSelectedKeywordId(null); setFetchResult(null); setNoScansInfo(null); setBulkFetchResults(null); setBulkFetchProgress(null); setShowGlobalSearch(false); setAutoFetchTriggered(null); } }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="heatmap-picker-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="w-5 h-5 text-primary" />
            Get Heatmap Data
          </DialogTitle>
          <DialogDescription>
            Fetch live data from Semrush, browse existing heatmaps, or import JSON
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setSelectedCampaignId(null); setSelectedKeywordId(null); setFetchResult(null); setBulkFetchResults(null); setBulkFetchProgress(null); }}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="semrush" data-testid="heatmap-tab-semrush">
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Fetch from Semrush
            </TabsTrigger>
            <TabsTrigger value="browse" data-testid="heatmap-tab-browse">
              <Search className="w-3.5 h-3.5 mr-1.5" />
              Browse Existing
            </TabsTrigger>
            <TabsTrigger value="import" data-testid="heatmap-tab-import">
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              Paste JSON
            </TabsTrigger>
          </TabsList>

          {/* SEMRUSH FETCH TAB */}
          <TabsContent value="semrush" className="mt-4 space-y-4">
            {!semrushStatus?.configured ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                <Key className="w-8 h-8 mx-auto mb-3 text-slate-300" />
                <p className="font-medium text-foreground mb-2" data-testid="text-semrush-status">
                  {semrushStatus?.expired ? "Semrush session expired" : "Semrush not connected"}
                </p>
                <p className="text-xs text-muted-foreground mb-4 max-w-sm mx-auto">
                  {semrushStatus?.expired
                    ? "Your Semrush session has expired — please re-authorize in the Integrations Hub."
                    : "Connect your Semrush account in the Integrations Hub to fetch Map Rank Tracker heatmap data."}
                </p>
                <Button
                  data-testid="link-semrush-integrations"
                  variant="outline"
                  asChild
                >
                  <Link href="/admin/integrations">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Go to Integrations
                  </Link>
                </Button>
              </div>
            ) : !selectedCampaignId ? (
              <>
                {mappedError && clientId ? (
                  <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                    <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                    <span className="text-amber-700 text-xs">
                      {`Could not load client campaigns: ${(mappedError as Error).message}`}
                    </span>
                  </div>
                ) : mappedLoading && clientId ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading client campaigns...</span>
                  </div>
                ) : hasMappedCampaigns ? (
                  <div className="space-y-3">
                    {!semrushAvailableForMapped && (
                      <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm" data-testid="semrush-auth-warning">
                        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                        <span className="text-amber-700 text-xs">
                          Semrush connection may need re-authorization. Campaigns are shown from saved mappings but live data may fail.
                        </span>
                      </div>
                    )}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium text-foreground uppercase tracking-wide" data-testid="semrush-client-campaigns-label">
                          Client Campaigns
                        </p>
                        {campaignSearch && filteredMappedCampaigns.length !== relevantMappedCampaigns.length && (
                          <p className="text-[10px] text-muted-foreground" data-testid="semrush-client-campaigns-filter-count">
                            {filteredMappedCampaigns.length} of {relevantMappedCampaigns.length} match
                          </p>
                        )}
                      </div>
                      {filteredMappedCampaigns.length === 0 ? (
                        <p
                          className="text-xs text-muted-foreground italic px-1 py-2"
                          data-testid="semrush-client-campaigns-empty"
                        >
                          No client campaigns match "{campaignSearch}"
                        </p>
                      ) : (
                      <div className="space-y-2">
                        {filteredMappedCampaigns.map((mc) => (
                          <div
                            key={`${mc.semrushCampaignId}-${mc.locationId}`}
                            data-testid={`semrush-mapped-campaign-${mc.semrushCampaignId}`}
                            className="border rounded-lg p-3 cursor-pointer transition-colors hover:bg-primary/5 border-primary/20 bg-primary/[0.02]"
                            onClick={() => setSelectedCampaignId(mc.semrushCampaignId)}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Building2 className="w-4 h-4 text-primary shrink-0" />
                                  <span className="text-sm font-medium text-foreground truncate">
                                    {mc.businessName || mc.semrushCampaignName || "Campaign"}
                                  </span>
                                  {mc.gridSettings?.template && (
                                    <Badge variant="outline" className="text-[10px] shrink-0">
                                      {mc.gridSettings.template}
                                    </Badge>
                                  )}
                                  <Badge className="text-[10px] bg-primary/10 text-primary border-primary/20 shrink-0">
                                    Linked
                                  </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground truncate ml-6">
                                  {mc.locationName}{mc.locationCity && mc.locationState ? ` — ${mc.locationCity}, ${mc.locationState}` : mc.address ? ` — ${mc.address}` : ""}
                                </p>
                              </div>
                              <ChevronRight className="w-4 h-4 text-primary shrink-0" />
                            </div>
                          </div>
                        ))}
                      </div>
                      )}
                    </div>
                    <div className="border-t border-border pt-3">
                      <p className="text-xs text-muted-foreground mb-2">Or search all Semrush campaigns:</p>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                        <Input
                          data-testid="semrush-campaign-search"
                          placeholder="Search campaigns by business name..."
                          value={campaignSearch}
                          onChange={(e) => { setCampaignSearch(e.target.value); setShowGlobalSearch(true); }}
                          onFocus={() => setShowGlobalSearch(true)}
                          className="pl-10"
                        />
                      </div>
                      {showGlobalSearch && (
                        <>
                          {campaignsError ? (
                            <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                              <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                              <span className="text-amber-700 text-xs">
                                {(campaignsError as Error).message?.includes("re-authorize")
                                  ? "Semrush authorization expired — re-connect in Integrations."
                                  : "Could not load campaigns. Semrush may need to be re-authorized."}
                              </span>
                            </div>
                          ) : campaignsLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                              <span className="ml-2 text-xs text-muted-foreground">Searching...</span>
                            </div>
                          ) : campaigns && campaigns.length > 0 ? (
                            <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                              {campaigns
                                .filter(c => !mappedCampaigns?.some(mc => mc.semrushCampaignId === c.id))
                                .map((campaign) => (
                                  <div
                                    key={campaign.id}
                                    data-testid={`semrush-campaign-${campaign.id}`}
                                    className="border rounded-lg p-2.5 cursor-pointer transition-colors hover:bg-muted/50 border-border"
                                    onClick={() => setSelectedCampaignId(campaign.id)}
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                        <div className="min-w-0">
                                          <span className="text-sm text-foreground truncate block">
                                            {campaign.businessName || campaign.name || "Unnamed Campaign"}
                                          </span>
                                          {(campaign.location || campaign.address) && (
                                            <span className="text-[10px] text-muted-foreground truncate block">
                                              {campaign.location || campaign.address}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                    </div>
                                  </div>
                                ))}
                            </div>
                          ) : campaignSearch ? (
                            <p className="text-xs text-muted-foreground text-center py-2">No campaigns match your search</p>
                          ) : null}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        data-testid="semrush-campaign-search"
                        placeholder="Search campaigns by business name..."
                        value={campaignSearch}
                        onChange={(e) => setCampaignSearch(e.target.value)}
                        className="pl-10"
                      />
                    </div>

                    {campaignsError ? (
                      <div className="text-center py-6">
                        <AlertCircle className="w-8 h-8 mx-auto mb-3 text-amber-400" />
                        <p className="font-medium text-foreground mb-1 text-sm">Semrush connection issue</p>
                        <p className="text-xs text-muted-foreground mb-3 max-w-sm mx-auto">
                          {(campaignsError as Error).message?.includes("re-authorize")
                            ? "Your Semrush authorization has expired. Please re-connect in the Integrations Hub."
                            : "Could not reach Semrush. The connection may need to be re-authorized."}
                        </p>
                        <Button
                          data-testid="link-semrush-reauth"
                          variant="outline"
                          size="sm"
                          asChild
                        >
                          <Link href="/admin/integrations">
                            <ExternalLink className="w-4 h-4 mr-2" />
                            Re-connect Semrush
                          </Link>
                        </Button>
                      </div>
                    ) : campaignsLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-sm text-muted-foreground">Loading campaigns from Semrush...</span>
                      </div>
                    ) : campaigns && campaigns.length > 0 ? (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        {campaigns.map((campaign) => (
                          <div
                            key={campaign.id}
                            data-testid={`semrush-campaign-${campaign.id}`}
                            className="border rounded-lg p-3 cursor-pointer transition-colors hover:bg-muted/50 border-border"
                            onClick={() => setSelectedCampaignId(campaign.id)}
                          >
                            <div className="flex items-center justify-between">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <Building2 className="w-4 h-4 text-primary shrink-0" />
                                  <span className="text-sm font-medium text-foreground truncate">
                                    {campaign.businessName || campaign.name || "Unnamed Campaign"}
                                  </span>
                                  {campaign.gridSettings?.template && (
                                    <Badge variant="outline" className="text-[10px] shrink-0">
                                      {campaign.gridSettings.template}
                                    </Badge>
                                  )}
                                </div>
                                {(campaign.location || campaign.address) && (
                                  <p className="text-xs text-muted-foreground truncate ml-6">{campaign.location || campaign.address}</p>
                                )}
                              </div>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-sm text-muted-foreground">
                        {campaignSearch ? "No campaigns match your search" : "No campaigns found in Semrush"}
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      // Mark that the user explicitly went back so the
                      // lone-campaign auto-select effect does not immediately
                      // re-select and make this button appear dead.
                      userWentBack.current = true;
                      setSelectedCampaignId(null);
                      setSelectedKeywordId(null);
                      setFetchResult(null);
                      setBulkFetchResults(null);
                      setBulkFetchProgress(null);
                      // Reset so re-entering the campaign later re-fires the
                      // auto bulk-fetch correctly (guarded by #2493 double-fire
                      // prevention via autoFetchTriggered).
                      setAutoFetchTriggered(null);
                    }}
                    data-testid="semrush-back-campaigns"
                  >
                    ← Back to campaigns
                  </Button>
                  <span className="text-sm font-medium text-foreground truncate">
                    {selectedCampaignLabel}
                  </span>
                </div>

                {/* Bulk fetch results */}
                {bulkFetchResults && bulkFetchResults.length === 0 && (
                  <div className="border rounded-lg p-4 bg-red-50 border-red-200 space-y-3" data-testid="semrush-bulk-fetch-empty">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-red-800">
                          All keyword fetches failed
                        </p>
                        <p className="text-xs text-red-600 mt-1">
                          None of the keywords returned heatmap data. Try fetching individual keywords or check your Semrush connection.
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        data-testid="semrush-bulk-retry"
                        variant="outline"
                        size="sm"
                        onClick={() => setBulkFetchResults(null)}
                        className="text-red-700 border-red-300"
                      >
                        Try Again
                      </Button>
                    </div>
                  </div>
                )}

                {bulkFetchResults && bulkFetchResults.length > 0 && (
                  <div className="border rounded-lg p-4 bg-green-50 border-green-200 space-y-3" data-testid="semrush-bulk-fetch-result">
                    <div className="flex items-start gap-2">
                      <Check className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-green-800">
                          {bulkFetchResults.length} heatmap{bulkFetchResults.length !== 1 ? "s" : ""} fetched successfully
                        </p>
                        <div className="mt-2 space-y-1">
                          {bulkFetchResults.map((r) => (
                            <div key={r.snapshotId} className="flex items-center justify-between text-xs text-green-700">
                              <span className="flex items-center gap-1.5">
                                <Key className="w-3 h-3" />
                                {r.keywordName}
                              </span>
                              <span>{r.pointCount} points</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <Button
                        data-testid="semrush-switch-individual"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setBulkFetchResults(null);
                        }}
                        className="text-xs h-8"
                      >
                        <Key className="w-3.5 h-3.5 mr-1" />
                        Fetch Individual Keyword
                      </Button>
                      <Button
                        data-testid="semrush-use-all-fetched"
                        onClick={() => {
                          void queryClient.invalidateQueries({ queryKey: ["/api/heatmaps/search"] }); // fire-and-forget: cache refresh only
                          onSelect(bulkFetchResults.map(r => r.snapshotId));
                          onClose();
                        }}
                        className="bg-primary hover:bg-primary/90"
                      >
                        <Layers className="w-4 h-4 mr-1.5" />
                        Use All {bulkFetchResults.length} Heatmaps
                      </Button>
                    </div>
                  </div>
                )}

                {/* Bulk fetch progress */}
                {bulkFetchProgress && (
                  <div className="border rounded-lg p-4 bg-blue-50 border-blue-200" data-testid="semrush-bulk-progress">
                    <div className="flex items-center gap-3">
                      <Loader2 className="w-5 h-5 animate-spin text-blue-600 shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-blue-800">
                          Fetching all keywords...
                        </p>
                        <p className="text-xs text-blue-600 mt-0.5">
                          This may take a moment for campaigns with multiple keywords
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {!bulkFetchResults && !bulkFetchProgress && (
                  <div className="border rounded-lg p-3 bg-muted/50">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-sm font-medium text-foreground">Keywords</p>
                      {activeKeywords.length > 1 && (
                        <Button
                          data-testid="semrush-fetch-all"
                          size="sm"
                          onClick={() => fetchAllMutation.mutate({ campaignId: selectedCampaignId! })}
                          disabled={fetchAllMutation.isPending}
                          className="bg-primary hover:bg-primary/90 h-8 text-xs gap-1.5"
                        >
                          {fetchAllMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Layers className="w-3.5 h-3.5" />
                          )}
                          Fetch All {activeKeywords.length} Keywords
                        </Button>
                      )}
                    </div>
                    {keywordsError ? (
                      <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm">
                        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                        <span className="text-amber-700 text-xs">
                          {(keywordsError as Error).message?.includes("re-authorize") || (keywordsError as Error).message?.includes("401")
                            ? "Semrush authorization expired. Please re-connect in Integrations Hub."
                            : `Could not load keywords: ${(keywordsError as Error).message}`}
                        </span>
                      </div>
                    ) : keywordsLoading ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                        <span className="ml-2 text-sm text-muted-foreground">Loading keywords...</span>
                      </div>
                    ) : activeKeywords.length > 0 ? (
                      <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                        <p className="text-xs text-muted-foreground mb-1">Or select one keyword:</p>
                        {activeKeywords.map((kw) => (
                          <div
                            key={kw.id}
                            data-testid={`semrush-keyword-${kw.id}`}
                            className={`flex items-center justify-between p-2.5 rounded-md border cursor-pointer transition-colors ${
                              selectedKeywordId === kw.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:bg-card"
                            }`}
                            onClick={() => setSelectedKeywordId(kw.id)}
                          >
                            <div className="flex items-center gap-2">
                              <Key className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-sm text-foreground">{kw.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              {kw.status === "COLLECTED" && (
                                <Badge variant="outline" className="text-[10px] text-green-600 border-green-300">
                                  Ready
                                </Badge>
                              )}
                              {selectedKeywordId === kw.id && (
                                <Check className="w-4 h-4 text-primary" />
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-4">No keywords found for this campaign</p>
                    )}
                  </div>
                )}

                {fetchResult && (
                  <div className="border rounded-lg p-4 bg-green-50 border-green-200 space-y-3" data-testid="semrush-fetch-result">
                    <div className="flex items-start gap-2">
                      <Check className="w-5 h-5 text-green-600 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-green-800">
                          Heatmap fetched — {fetchResult.pointCount} grid points imported
                        </p>
                        <p className="text-xs text-green-700 mt-1" data-testid="semrush-fetch-date-info">
                          <Calendar className="w-3 h-3 inline mr-1" />
                          Semrush data from{" "}
                          <span className="font-medium">
                            {new Date(fetchResult.semrushReportDate).toLocaleDateString("en-US", {
                              month: "long",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </span>
                        </p>
                        {fetchResult.dateMatchType === "prior_fallback" && reportMonth && (
                          <p className="text-xs text-amber-700 mt-1" data-testid="semrush-date-fallback-warning">
                            <AlertCircle className="w-3 h-3 inline mr-1" />
                            No collection date found within{" "}
                            {(() => {
                              const [y, m] = reportMonth.split("-").map(Number);
                              return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
                            })()}
                            . Using the most recent prior date.
                          </p>
                        )}
                        {fetchResult.dateMatchType === "latest_fallback" && reportMonth && (
                          <p className="text-xs text-amber-700 mt-1" data-testid="semrush-date-no-match-warning">
                            <AlertCircle className="w-3 h-3 inline mr-1" />
                            No collection dates available on or before{" "}
                            {(() => {
                              const [y, m] = reportMonth.split("-").map(Number);
                              return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
                            })()}
                            . Using the latest available data.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <Button
                        data-testid="semrush-use-fetched"
                        onClick={() => {
                          void queryClient.invalidateQueries({ queryKey: ["/api/heatmaps/search"] }); // fire-and-forget: cache refresh only
                          onSelect([fetchResult.snapshotId]);
                          onClose();
                        }}
                        className="bg-primary hover:bg-primary/90"
                      >
                        <Check className="w-4 h-4 mr-1.5" />
                        Use This Heatmap
                      </Button>
                    </div>
                  </div>
                )}

                {noScansInfo && !fetchResult && (
                  <div
                    className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                    data-testid="heatmap-no-scans-notice"
                  >
                    <p className="font-medium">No map rank scans yet</p>
                    <p className="mt-1 text-amber-800">{noScansInfo.message}</p>
                    {noScansInfo.nextReportDate && (
                      <p className="mt-1 text-xs text-amber-700">
                        <Calendar className="w-3 h-3 inline mr-1" />
                        Next scheduled scan: {noScansInfo.nextReportDate}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-amber-700">
                      Use the “or Upload PNG” option on the location card to add a
                      screenshot manually in the meantime.
                    </p>
                  </div>
                )}

                {selectedKeywordId && !fetchResult && !bulkFetchResults && (
                  <div className="space-y-2">
                    {reportMonth && (
                      <p className="text-xs text-muted-foreground text-right" data-testid="semrush-report-month-note">
                        <Calendar className="w-3 h-3 inline mr-1" />
                        Will pull data closest to end of{" "}
                        {(() => {
                          const [y, m] = reportMonth.split("-").map(Number);
                          return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
                        })()}
                      </p>
                    )}
                    <div className="flex justify-end">
                      <Button
                        data-testid="semrush-fetch-heatmap"
                        onClick={() => fetchHeatmapMutation.mutate({ campaignId: selectedCampaignId!, keywordId: selectedKeywordId })}
                        disabled={fetchHeatmapMutation.isPending}
                        className="bg-primary hover:bg-primary/90"
                      >
                        {fetchHeatmapMutation.isPending ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                            Fetching from Semrush...
                          </>
                        ) : (
                          <>
                            <Download className="w-4 h-4 mr-1.5" />
                            Fetch Heatmap Data
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* BROWSE EXISTING TAB */}
          <TabsContent value="browse" className="mt-4 space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                data-testid="heatmap-search-input"
                placeholder="Search by client, location, keyword, or business name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => { if (searchQuery.trim()) logActivity("search", "Searched heatmaps", { query: searchQuery.trim() }); }}
                className="pl-10"
              />
            </div>

            {previewSnapshotId && (
              <div className="border rounded-lg p-3 bg-muted/50">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-foreground">Preview</span>
                    {(() => {
                      const previewSnap = snapshots?.find((s) => s.id === previewSnapshotId);
                      if (!previewSnap) return null;
                      return previewSnap.clientName ? (
                        <span
                          data-testid="heatmap-preview-client-name"
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary bg-primary/8 rounded px-1.5 py-0.5 truncate"
                        >
                          {previewSnap.clientName}
                        </span>
                      ) : (
                        <span
                          data-testid="heatmap-preview-client-name"
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground italic"
                        >
                          No client linked
                        </span>
                      );
                    })()}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPreviewSnapshotId(null)}
                      data-testid="heatmap-close-preview"
                    >
                      Close Preview
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleSelectSnapshot(previewSnapshotId)}
                      data-testid="heatmap-use-this"
                    >
                      <Check className="w-3.5 h-3.5 mr-1" />
                      Use This Heatmap
                    </Button>
                  </div>
                </div>
                <InteractiveHeatmap snapshotId={previewSnapshotId} compact={true} />
              </div>
            )}

            {searchLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : (snapshots && snapshots.length > 0) ? (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {snapshots.map((snap) => (
                  <div
                    key={snap.id}
                    data-testid={`heatmap-snapshot-${snap.id}`}
                    className={`border rounded-lg p-3 cursor-pointer transition-colors hover:bg-muted/50 ${previewSnapshotId === snap.id ? 'border-primary bg-primary/5' : 'border-border'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-foreground truncate">
                            {snap.locationName}
                          </span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {snap.gridTemplate}
                          </Badge>
                        </div>
                        <div className="mb-1">
                          {snap.clientName ? (
                            <span
                              data-testid={`heatmap-client-name-${snap.id}`}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary bg-primary/8 rounded px-1.5 py-0.5"
                            >
                              {snap.clientName}
                            </span>
                          ) : (
                            <span
                              data-testid={`heatmap-client-name-${snap.id}`}
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground italic"
                            >
                              No client linked
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Grid3X3 className="w-3 h-3" />
                            {snap.keywordName}
                          </span>
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            {formatDate(snap.reportDate)}
                          </span>
                          {snap.pointsNumber && (
                            <span>{snap.pointsNumber} pts</span>
                          )}
                        </div>
                        {snap.metrics && (
                          <div className="flex items-center gap-3 mt-1 text-[11px]">
                            {snap.metrics.avgRank !== null && snap.metrics.avgRank !== undefined && (
                              <span className="text-muted-foreground">
                                Avg: <span className="font-medium">#{snap.metrics.avgRank.toFixed(1)}</span>
                              </span>
                            )}
                            {snap.metrics.top3CoveragePct !== null && snap.metrics.top3CoveragePct !== undefined && (
                              <span className="text-green-600">
                                Top 3: <span className="font-medium">{snap.metrics.top3CoveragePct}%</span>
                              </span>
                            )}
                            {snap.metrics.top10CoveragePct !== null && snap.metrics.top10CoveragePct !== undefined && (
                              <span className="text-blue-600">
                                Top 10: <span className="font-medium">{snap.metrics.top10CoveragePct}%</span>
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 ml-3 shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewSnapshotId(previewSnapshotId === snap.id ? null : snap.id);
                          }}
                          data-testid={`heatmap-preview-${snap.id}`}
                        >
                          <Eye className="w-3.5 h-3.5 mr-1" />
                          Preview
                        </Button>
                        <Button
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSelectSnapshot(snap.id);
                          }}
                          data-testid={`heatmap-select-${snap.id}`}
                        >
                          <Check className="w-3.5 h-3.5 mr-1" />
                          Use
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-sm text-muted-foreground">
                {searchQuery ? "No heatmaps match your search" : "No heatmaps imported yet"}
              </div>
            )}
          </TabsContent>

          {/* PASTE JSON TAB */}
          <TabsContent value="import" className="mt-4 space-y-4">
            <div>
              <Label className="text-sm font-medium">Paste Semrush Heatmap JSON</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Paste the raw JSON data exported from Semrush Map Rank Tracker
              </p>
              <Textarea
                data-testid="heatmap-json-input"
                placeholder={`{
  "locationId": "loc-123",
  "locationName": "Downtown Office",
  "businessName": "Smith & Associates",
  "campaignId": "campaign-456",
  "keywordName": "personal injury lawyer",
  "reportDate": "2026-03-01",
  "businessLat": 33.749,
  "businessLng": -84.388,
  "gridTemplate": "9x9",
  "gridUnit": "MILES",
  "gridDistance": 5,
  "baseLat": 33.749,
  "baseLng": -84.388,
  "points": [
    { "lat": 33.75, "lng": -84.39, "position": 3, "diff": 2 },
    ...
  ]
}`}
                value={rawJsonInput}
                onChange={(e) => {
                  setRawJsonInput(e.target.value);
                  setImportError(null);
                }}
                className="font-mono text-xs min-h-[240px]"
              />
            </div>

            {importError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{importError}</span>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                Required: locationId, locationName, campaignId, keywordName, reportDate, businessLat/Lng, baseLat/Lng, gridTemplate, gridUnit, gridDistance, points[]
              </div>
              <Button
                data-testid="heatmap-import-submit"
                onClick={handleImportRawJson}
                disabled={!rawJsonInput.trim() || importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-1.5" />
                )}
                Import & Link
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
