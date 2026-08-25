import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useParams, useLocation, useSearch } from "wouter";
import { Save, Eye, EyeOff, Copy, Plus, Trash2, AlertTriangle, Upload, ImageIcon, X, Check, ChevronsUpDown, CheckCircle2, AlertCircle, HelpCircle, Sparkles, Loader2, Pencil, MapPin, Grid3X3, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import HeatmapPicker from "@/components/HeatmapPicker";
import InteractiveHeatmap from "@/components/InteractiveHeatmap";
import SectionAuditInfo from "@/components/SectionAuditInfo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ObjectUploader } from "@/components/ObjectUploader";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState, useEffect, useMemo, useCallback, useRef, useSyncExternalStore, type ComponentProps } from "react";
import { useAutosave } from "@/hooks/use-autosave";
import {
  createAutosaveAggregator,
  deriveAutosaveIndicator,
  type AutosaveAggregator,
} from "@/lib/reportAutosaveAggregate";
import { logActivity } from "@/hooks/use-activity-tracker";
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts";
import { normalizeProductList, getProductLabel } from "@shared/productResolution";
import { applyHideOtherLeads, resolveMissedCallRate, resolveMissedCallRateWithSource } from "@shared/missedCallRate";
// Task #4273 — per-slide verdict sentences: shared keys/labels + the SAME
// quality floor the server enforces at finalize (inline hints stay honest).
import {
  SLIDE_VERDICT_KEYS,
  SLIDE_VERDICT_LABELS,
  findDegenerateVerdict,
  verdictProblemLabel,
  sanitizeSlideVerdictMap,
  type SlideVerdictKey,
  type SlideVerdictMap,
} from "@shared/slideVerdicts";
import { importMetricNotFound, importCompositeSubFieldNotFound, COMPOSITE_NUMERIC_SUBFIELDS } from "@shared/importMetricPresence";
import {
  ClientSaveError,
  parseClientSaveError,
} from "@/lib/clientProductErrors";
import { FormSkeleton } from "@/components/ui/skeleton-loaders";
// Task #4254 — curated Common Issues copy library, offered (never
// auto-applied) when the finalize quality gate flags a section as thin.
import {
  getCuratedIssueBlocks,
  renderCuratedIssueBlocks,
  type CommonIssuesSection,
} from "@shared/commonIssuesCopyLibrary";
import { getTermLabel, type ClientTerminology, type DataAccessDetectionMap, classifyDataAccessForReport, NEXT_ACTION_OWNER_MAX_CHARS, NEXT_ACTION_DUE_MAX_CHARS } from "@shared/schema";

type Client = {
  id: string;
  firmName: string;
  averageCaseValue: number | null;
  products: string[] | null;
  consultType: string | null;
  terminology?: ClientTerminology | null;
  hideOtherLeads?: boolean | null;
};

type DataAccessItem = {
  id: string;
  clientId: string;
  category: string;
  status: string;
};

type ClientLocation = {
  id: string;
  clientId: string;
  name: string;
};

type Report = {
  id: string;
  clientId: string;
  reportMonth: string;
  status: string;
  shareToken: string | null;
  privacyMode: boolean | null;
  hideLeadQuality: boolean | null;
  webhookImportLogId: string | null;
  hasStoredPdfUrl?: boolean;
  // Task #4537 — "Presented / Delivered" mark (server-stamped; JSON-serialized
  // timestamps arrive as ISO strings).
  presentedAt?: string | null;
  presentedBy?: string | null;
};

type ActionItem = {
  action: string;
  why: string;
  // Task #4282 — optional accountability fields (owner initials + due hint).
  owner?: string;
  due?: string;
};

type GBPLocationData = {
  id: string;
  name: string;
  uniqueLeads: number;
  reviewsGenerated: number;
  reviewsRespondedTo: number;
  postsQaCount: number;
  heatmapImageUrl?: string;
  heatmapSnapshotId?: string;
  heatmapSnapshotIds?: string[];
  leadQuality: {
    good: number;
    notQuotable: number;
    missedCalls: number;
    noData: number;
  };
};
import { mergeImportedGbpLocations } from "@/lib/gbpLocationMerge";
import { LEAD_SOURCE_COLORS } from "@/lib/leadSourceColors";

function HeatmapTabLabel({ snapshotId, fallback }: { snapshotId: string; fallback: string }) {
  const { data } = useQuery<{ keywordName?: string }>({
    queryKey: [`/api/heatmaps/${snapshotId}/meta`],
    queryFn: async () => {
      const res = await fetch(`/api/heatmaps/${snapshotId}/meta`, { credentials: "include" });
      if (!res.ok) return { keywordName: fallback };
      const d = await res.json();
      return { keywordName: d.snapshot?.keywordName || fallback };
    },
    staleTime: Infinity,
  });
  return <>{data?.keywordName || fallback}</>;
}

function LocationHeatmapTabs({ snapshotIds, locationIdx }: { snapshotIds: string[]; locationIdx: number }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const clampedIdx = Math.min(activeIdx, snapshotIds.length - 1);

  if (snapshotIds.length === 1) {
    return <InteractiveHeatmap snapshotId={snapshotIds[0]} compact={true} />;
  }

  return (
    <div className="space-y-2" data-testid={`heatmap-tabs-loc-${locationIdx}`}>
      <div className="flex gap-1 flex-wrap">
        {snapshotIds.map((id, i) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveIdx(i)}
            className={`px-2.5 py-1 text-caption rounded-full border transition-colors ${
              clampedIdx === i
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card text-muted-foreground border-border hover:bg-muted/50"
            }`}
            data-testid={`heatmap-tab-kw-${locationIdx}-${i}`}
          >
            <HeatmapTabLabel snapshotId={id} fallback={`Map ${i + 1}`} />
          </button>
        ))}
      </div>
      <InteractiveHeatmap
        key={snapshotIds[clampedIdx]}
        snapshotId={snapshotIds[clampedIdx]}
        compact={true}
      />
    </div>
  );
}

// Helper function to safely parse numeric inputs - prevents NaN and negative values
function safeNumber(value: string | number, options: { min?: number; max?: number; allowDecimal?: boolean } = {}): number {
  const { min = 0, max, allowDecimal = true } = options;
  let num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num) || !isFinite(num)) return min;
  if (!allowDecimal) num = Math.floor(num);
  if (num < min) return min;
  if (max !== undefined && num > max) return max;
  return num;
}

// Decimal-capable controlled input (Task #2768). A controlled type="number"
// input that parses on every keystroke cannot hold the intermediate "8." state
// (safeNumber("8.") === 8, so the re-render strips the dot). This component
// keeps a string DRAFT of exactly what the user typed while they edit, commits
// the safeNumber-parsed value to form state on each change, and normalizes the
// displayed text from the committed number on blur (and whenever the numeric
// state changes externally, e.g. PDF import, while not editing).
export function DecimalInput({
  value,
  onCommit,
  max,
  ...inputProps
}: {
  value: number;
  onCommit: (n: number) => void;
  max?: number;
} & Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur" | "type" | "max">) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={draft ?? String(value)}
      onChange={e => {
        // Strip locale/currency formatting (commas, "$", spaces) so pasting
        // spreadsheet values like "$1,000.50" works (Task #2771).
        const raw = e.target.value.replace(/[,$\s]/g, "");
        // Only digits with at most one decimal point (fields are non-negative).
        if (!/^\d*\.?\d*$/.test(raw)) return;
        setDraft(raw);
        onCommit(safeNumber(raw, { max }));
      }}
      onBlur={() => setDraft(null)}
      {...inputProps}
    />
  );
}

export default function ReportForm() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Report Editor");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = useParams<{ id?: string }>();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const [, navigate] = useLocation();
  
  // Track the active report ID - either from URL params or from created/found report
  const [activeReportId, setActiveReportId] = useState<string | undefined>(params.id);
  
  // Track if we've already loaded report data to prevent overwriting user edits
  const [dataLoadedForReportId, setDataLoadedForReportId] = useState<string | null>(null);
  
  const [inactiveLeadsDismissed, setInactiveLeadsDismissed] = useState(false);
  const [inactiveLeadsDialogOpen, setInactiveLeadsDialogOpen] = useState(false);
  const [selectedProductsToAdd, setSelectedProductsToAdd] = useState<string[]>([]);

  // Track pending heatmap saves to trigger auto-save after upload
  const [pendingHeatmapSave, setPendingHeatmapSave] = useState<{ idx: number; url: string } | null>(null);
  
  // Heatmap picker dialog state
  const [heatmapPickerOpen, setHeatmapPickerOpen] = useState(false);
  const [heatmapPickerLocationIdx, setHeatmapPickerLocationIdx] = useState<number>(0);
  const [heatmapPickerLocationName, setHeatmapPickerLocationName] = useState<string>("");
  const [heatmapPickerLocationId, setHeatmapPickerLocationId] = useState<string>("");

  // Inline "Add to Command Panel" affordance for stale report-row GBP locations.
  const [addToCpIdx, setAddToCpIdx] = useState<number | null>(null);
  const [addToCpAddress, setAddToCpAddress] = useState("");
  const [addToCpError, setAddToCpError] = useState("");

  // Track section updatedAt timestamps for concurrency control
  const [sectionTimestamps, setSectionTimestamps] = useState<Record<string, string>>({});
  
  // PDF Import state
  const [isReimporting, setIsReimporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [clientPopoverOpen, setClientPopoverOpen] = useState(false);
  const [importedData, setImportedData] = useState<any>(null);
  const [showImportReview, setShowImportReview] = useState(false);
  const [pendingImportData, setPendingImportData] = useState<any>(null);
  // Imported GBP location names that resolved to neither an existing report row
  // nor the client's Command Panel. Surfaced to the operator instead of being
  // silently added as confident (and possibly foreign) ghost rows.
  const [unresolvedGbpImports, setUnresolvedGbpImports] = useState<string[]>([]);
  // Task #3769 — broken-source import warning. Persisted on the intake/sales
  // section data (`brokenSourceImportWarning`) by all three import paths when
  // parsed Consults/Cases resolve to "not entered" while the client's most
  // recent prior report had them entered, or the raw Common Issues matched
  // the "Missing data source" placeholder. Hydrated on load, set immediately
  // from the reimport response, cleared server-side when the operator saves
  // the section (same lifecycle as gbpUnresolvedImports).
  const [brokenSourceWarning, setBrokenSourceWarning] = useState<{
    missingMetrics: string[];
    placeholderSections: string[];
    priorReportMonth: string | null;
  } | null>(null);
  // Task #3769 — funnel metrics still missing at finalize time (per the
  // broken-source warning) that the operator must explicitly confirm.
  const [funnelConfirmMetrics, setFunnelConfirmMetrics] = useState<string[]>([]);
  // Task #4227 — report-quality finalize gate gaps returned by the server
  // (degenerate Common Issues copy / empty Next 30 Days columns). Non-empty
  // = the confirm dialog carries the quality callout and "Finalize Anyway"
  // re-submits with confirmReportQualityFinalize: true.
  const [qualityGateGaps, setQualityGateGaps] = useState<string[]>([]);
  // Task #4254 — which sections the quality gate flagged for thin Common
  // Issues copy. Drives the curated copy-library picker inside the quality
  // callout; cleared in lockstep with qualityGateGaps.
  const [qualityGateThinSections, setQualityGateThinSections] = useState<CommonIssuesSection[]>([]);
  // Selected curated block ids (ids are unique across sections).
  const [curatedSelections, setCuratedSelections] = useState<Record<string, boolean>>({});
  const [importFieldSelections, setImportFieldSelections] = useState<Record<string, boolean>>({});
  // Task #2852 — set when a reimport's server response flags that the PDF's
  // webinar Lead Quality breakdown differs from the saved (possibly
  // hand-corrected) one. Surfaced inline on the Webinars row of the review
  // dialog (with the row pre-unchecked) so the operator makes an explicit
  // choice instead of relying on a dismissible toast.
  const [webinarConflictFlagged, setWebinarConflictFlagged] = useState(false);
  const [showMissingFieldsDialog, setShowMissingFieldsDialog] = useState(false);
  const [missingFields, setMissingFields] = useState<{section: string; fields: string[]}[]>([]);
  const [formattingIssues, setFormattingIssues] = useState<string | null>(null);
  const [editingIssues, setEditingIssues] = useState<{ intake: boolean; sales: boolean }>({ intake: false, sales: false });

  const formatCommonIssues = async (text: string, section: "intake" | "sales") => {
    if (!text.trim()) return;
    setFormattingIssues(section);
    try {
      const res = await fetch("/api/ai/format-issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ text, section, reportId: activeReportId || undefined }),
      });
      if (!res.ok) throw new Error("Failed to format");
      // Task #2389 — the server now always returns readable text: on AI failure
      // it degrades to a deterministic OCR-cleanup + marker-split fallback
      // instead of the raw run-on blob. `degraded` flags when that happened so
      // we can surface a non-blocking notice.
      const { formatted, degraded } = await res.json();
      if (section === "intake") {
        setIntakeData(prev => {
          const next = { ...prev, commonIssues: formatted };
          if (activeReportId) {
            saveSectionMutation.mutate({ sectionKey: "intake", data: next, isAutosave: true, editSource: "ai_format" });
          }
          return next;
        });
      } else {
        setSalesData(prev => {
          const next = { ...prev, commonIssues: formatted };
          if (activeReportId) {
            saveSectionMutation.mutate({ sectionKey: "sales", data: next, isAutosave: true, editSource: "ai_format" });
          }
          return next;
        });
      }
      if (degraded) {
        toast({
          title: "Issues cleaned up without AI",
          description: "The AI formatter was unavailable, so issues were tidied and split automatically. You can edit them manually if needed.",
        });
      }
    } catch (err) {
      toast({ title: "Failed to format issues", variant: "destructive" });
    } finally {
      setFormattingIssues(null);
    }
  };
  const [pendingFinalize, setPendingFinalize] = useState(false);
  
  // Update activeReportId when params.id changes (e.g., after navigation).
  // activeReportId is a safe dep here: re-runs where params.id === activeReportId
  // skip the reset branch and the setActiveReportId call is idempotent.
  useEffect(() => {
    if (params.id) {
      if (params.id !== activeReportId) {
        setDataLoadedForReportId(null);
      }
      setActiveReportId(params.id);
    }
  }, [params.id, activeReportId]);
  
  const isEditing = !!params.id || !!activeReportId;
  const preselectedClientId = searchParams.get("clientId");

  const [formData, setFormData] = useState({
    clientId: preselectedClientId || "",
    reportMonth: "",
    status: "draft",
    hideLeadQuality: false,
    // Task #4537 — operator "Presented / Delivered" mark; boolean only, the
    // server stamps who/when.
    presented: false,
  });

  // Track if we've prefilled noDataFlags for this client (to avoid overwriting user edits)
  const [prefillAppliedForClient, setPrefillAppliedForClient] = useState<string | null>(null);

  // Intake Section State - focused on consult handling
  const [intakeData, setIntakeData] = useState({
    totalConsults: 0,
    missedCallRate: 0,
    avgTimeToAnswer: 0,
    qualityScore: 0,
    commonIssues: "",
    // "No Data" flags for each field
    noDataFlags: {
      totalConsults: false,
      avgTimeToAnswer: false,
      qualityScore: false,
    } as Record<string, boolean>,
  });

  // Sales Section State - focused on conversion
  const [salesData, setSalesData] = useState({
    totalCases: 0,
    averageCaseValue: 0,
    noShowRate: 0,
    avgFollowUps: 0,
    qualityScore: 0,
    commonIssues: "",
    dealTouchDensity: 0,
    avgAgeOpenMatters: 0,
    pipelineMomentumScore: 0,
    noDataFlags: {
      totalCases: false,
      averageCaseValue: false,
      noShowRate: false,
      avgFollowUps: false,
      qualityScore: false,
      dealTouchDensity: false,
      avgAgeOpenMatters: false,
      pipelineMomentumScore: false,
    } as Record<string, boolean>,
  });

  // Marketing Section State - includes all lead data
  const [marketingData, setMarketingData] = useState({
    totalLeads: 0,
    posture: "" as "" | "baseline" | "ramp-up" | "stable" | "scaling",
    leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    gbpLocations: [] as GBPLocationData[],
    blogPostUrl: "",
    googleAdsEnabled: true,
    lsaEnabled: true,
    googleAds: {
      uniqueLeads: 0,
      adSpend: 0,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
    lsa: {
      uniqueLeads: 0,
      adSpend: 0,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
    webinar: {
      registrants: 0,
      attendees: 0,
      hotTransfers: 0,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
    reviewGeneration: {
      listContacted: 0,
      listReviews: 0,
      webinarReviews: 0,
      otherCount: 0,
      totalReviews: 0,
      monthlyTarget: 0,
    },
    otherLeads: {
      count: 0,
      description: "",
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    },
  });

  // Next 30 Days Section State
  const [nextActionsData, setNextActionsData] = useState({
    ours: [] as ActionItem[],
    theirs: [] as ActionItem[],
    notes: "",
    showNotes: false,
    // Task #4282 — expansion band is opt-in per report (default hidden).
    showExpansionQuestion: false,
  });
  const [newOurAction, setNewOurAction] = useState({ action: "", why: "", owner: "", due: "" });
  const [newTheirAction, setNewTheirAction] = useState({ action: "", why: "", owner: "", due: "" });
  const [activeTab, setActiveTab] = useState("marketing");

  // Task #4273 — per-slide verdict sentences (Verdicts tab). Sparse map
  // hydrated from the internal `slideVerdicts` section row; saves flow
  // through the strict slideVerdicts branch of the section PUT.
  const [verdictsData, setVerdictsData] = useState<SlideVerdictMap>({});
  const [draftingVerdictKey, setDraftingVerdictKey] = useState<SlideVerdictKey | null>(null);
  const [verdictsSavedJson, setVerdictsSavedJson] = useState("{}");
  // Live mirror of verdictsData for async continuations: the AI-draft apply
  // resolves seconds after it started, so merging into its own start-time
  // closure would drop any verdict the operator typed meanwhile (and then
  // autosave that regressed map). Always merge against the ref.
  const verdictsDataRef = useRef<SlideVerdictMap>({});
  useEffect(() => {
    verdictsDataRef.current = verdictsData;
  }, [verdictsData]);

  // Webinar Lead Equivalency: Each booked consultation from webinar = 1.6 Lead Equivalents
  // Reflects historical intake conversion rate of standard inbound leads to produce a booked consultation
  const WEBINAR_LEAD_EQUIVALENCY = 1.6;

  // Lead quality validation helpers for each source
  const getLeadQualitySum = (lq: { good: number; notQuotable: number; missedCalls: number; noData: number }) => {
    return (lq.good || 0) + (lq.notQuotable || 0) + (lq.missedCalls || 0) + (lq.noData || 0);
  };

  // Review generation calculated activation rates
  const listActivationRate = useMemo(() => {
    if (marketingData.reviewGeneration.listContacted === 0) return 0;
    return Math.round((marketingData.reviewGeneration.listReviews / marketingData.reviewGeneration.listContacted) * 1000) / 10;
  }, [marketingData.reviewGeneration.listContacted, marketingData.reviewGeneration.listReviews]);

  const webinarActivationRate = useMemo(() => {
    if (marketingData.webinar.attendees === 0) return 0;
    return Math.round((marketingData.reviewGeneration.webinarReviews / marketingData.webinar.attendees) * 1000) / 10;
  }, [marketingData.webinar.attendees, marketingData.reviewGeneration.webinarReviews]);

  // Total reviews from review generation sources (list + webinar + other)
  const totalReviewsFromSources = useMemo(() => {
    return (marketingData.reviewGeneration.listReviews || 0) + 
           (marketingData.reviewGeneration.webinarReviews || 0) + 
           (marketingData.reviewGeneration.otherCount || 0);
  }, [marketingData.reviewGeneration]);

  // Total reviews from GBP locations
  const totalGbpReviews = useMemo(() => {
    return marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.reviewsGenerated || 0), 0);
  }, [marketingData.gbpLocations]);

  // Effective total reviews: use the explicit totalReviews field if set, otherwise fall back to sum of sources
  const effectiveTotalReviews = (marketingData.reviewGeneration.totalReviews || 0) > 0
    ? marketingData.reviewGeneration.totalReviews
    : totalReviewsFromSources;

  // Review count mismatch warning
  const reviewCountMismatch = effectiveTotalReviews !== totalGbpReviews && (effectiveTotalReviews > 0 || totalGbpReviews > 0);

  const consultToCaseRate = useMemo(() => {
    if (intakeData.totalConsults === 0) return 0;
    return Math.round((salesData.totalCases / intakeData.totalConsults) * 1000) / 10;
  }, [intakeData.totalConsults, salesData.totalCases]);

  const googleAdsCostPerLead = useMemo(() => {
    if (marketingData.googleAds.uniqueLeads === 0) return 0;
    return Math.round(marketingData.googleAds.adSpend / marketingData.googleAds.uniqueLeads);
  }, [marketingData.googleAds.adSpend, marketingData.googleAds.uniqueLeads]);

  const lsaCostPerLead = useMemo(() => {
    if (marketingData.lsa.uniqueLeads === 0) return 0;
    return Math.round(marketingData.lsa.adSpend / marketingData.lsa.uniqueLeads);
  }, [marketingData.lsa.adSpend, marketingData.lsa.uniqueLeads]);

  const webinarShowRate = useMemo(() => {
    if (marketingData.webinar.registrants === 0) return 0;
    return Math.round((marketingData.webinar.attendees / marketingData.webinar.registrants) * 100);
  }, [marketingData.webinar.registrants, marketingData.webinar.attendees]);

  const webinarHotTransferRate = useMemo(() => {
    if (marketingData.webinar.attendees === 0) return 0;
    return Math.round((marketingData.webinar.hotTransfers / marketingData.webinar.attendees) * 100);
  }, [marketingData.webinar.attendees, marketingData.webinar.hotTransfers]);

  const { data: clients } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch("/api/clients", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: clientLocations } = useQuery<ClientLocation[]>({
    queryKey: ["/api/clients", formData.clientId, "locations"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${formData.clientId}/locations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
    enabled: !!user && !!formData.clientId,
  });

  const { data: dataAccess } = useQuery<DataAccessItem[]>({
    queryKey: ["/api/clients", formData.clientId, "data-access"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${formData.clientId}/data-access`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch data access");
      return res.json();
    },
    enabled: !!user && !!formData.clientId,
  });

  // Task #2418 — advisory data-presence detection. Lets the missing-data
  // section distinguish "genuinely absent" (red critical) from "data is
  // flowing but the flag isn't set" (softer confirm prompt). Advisory only;
  // never auto-flips a flag.
  const { data: dataAccessDetection } = useQuery<DataAccessDetectionMap>({
    queryKey: ["/api/clients", formData.clientId, "data-access", "detection"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${formData.clientId}/data-access/detection`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch data access detection");
      return res.json();
    },
    enabled: !!user && !!formData.clientId,
  });

  const { data: commandPanel, isFetched: commandPanelFetched } = useQuery<{ productTypes?: string[] | null } | null>({
    queryKey: ["/api/clients", formData.clientId, "command-panel"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${formData.clientId}/command-panel`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!user && !!formData.clientId,
  });

  const selectedClient = useMemo(() => {
    return clients?.find(c => c.id === formData.clientId);
  }, [clients, formData.clientId]);

  const t = useCallback(
    (key: Parameters<typeof getTermLabel>[1]) => getTermLabel(selectedClient?.terminology, key),
    [selectedClient?.terminology],
  );

  const commandPanelExists = commandPanelFetched && commandPanel !== null && commandPanel !== undefined;
  const clientProducts = useMemo(() => {
    if (!commandPanelFetched) {
      return normalizeProductList(selectedClient?.products || []);
    }
    if (commandPanelExists) {
      return normalizeProductList(Array.isArray(commandPanel?.productTypes) ? commandPanel.productTypes : []);
    }
    return normalizeProductList(selectedClient?.products || []);
  }, [commandPanelFetched, commandPanelExists, commandPanel, selectedClient]);

  const hasGbpProduct = clientProducts.includes("gbp");
  const hasGoogleAdsProduct = clientProducts.includes("google_ads");
  const hasLsaProduct = clientProducts.includes("lsa");
  const hasPaidProduct = hasGoogleAdsProduct || hasLsaProduct;
  const hasWebinarProduct = clientProducts.includes("webinar");

  const inactiveProductLeadSources = useMemo(() => {
    const sources: string[] = [];
    if (!hasGbpProduct && marketingData.gbpLocations.some(loc => (loc.uniqueLeads || 0) > 0)) {
      sources.push("GBP");
    }
    if (!hasGoogleAdsProduct && (marketingData.googleAds.uniqueLeads || 0) > 0) {
      sources.push("Google Ads");
    }
    if (!hasLsaProduct && (marketingData.lsa.uniqueLeads || 0) > 0) {
      sources.push("LSA");
    }
    if (!hasWebinarProduct && (marketingData.webinar.hotTransfers || 0) > 0) {
      sources.push("Webinar");
    }
    return sources;
  }, [hasGbpProduct, hasGoogleAdsProduct, hasLsaProduct, hasWebinarProduct, marketingData]);

  useEffect(() => {
    setInactiveLeadsDismissed(false);
    setInactiveLeadsDialogOpen(false);
  }, [formData.clientId]);

  // Auto-calculated total leads from all sources (respects product purchases and enabled flags)
  // Includes "Other" leads for sources not generated by our services
  const hasWebinarLeadQuality = (marketingData.webinar?.leadQuality?.good || 0) + (marketingData.webinar?.leadQuality?.notQuotable || 0) + (marketingData.webinar?.leadQuality?.missedCalls || 0) + (marketingData.webinar?.leadQuality?.noData || 0) > 0;

  const webinarLeadCount = useMemo(() => {
    return hasWebinarProduct
      ? (hasWebinarLeadQuality
          ? ((marketingData.webinar?.leadQuality?.good || 0) + (marketingData.webinar?.leadQuality?.notQuotable || 0) + (marketingData.webinar?.leadQuality?.missedCalls || 0) + (marketingData.webinar?.leadQuality?.noData || 0))
          : Math.ceil((marketingData.webinar.hotTransfers || 0) * WEBINAR_LEAD_EQUIVALENCY))
      : 0;
  }, [marketingData.webinar?.leadQuality, marketingData.webinar.hotTransfers, hasWebinarProduct, hasWebinarLeadQuality]);

  const webinarLeadEquiv = useMemo(() => {
    if (!hasWebinarProduct || webinarLeadCount === 0) return 0;
    if (hasWebinarLeadQuality) return Math.ceil(webinarLeadCount * WEBINAR_LEAD_EQUIVALENCY);
    return webinarLeadCount;
  }, [webinarLeadCount, hasWebinarProduct, hasWebinarLeadQuality]);

  const totalLeadsExcludingWebinar = useMemo(() => {
    const gbpLeads = hasGbpProduct ? marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.uniqueLeads || 0), 0) : 0;
    const googleAdsLeads = hasGoogleAdsProduct && marketingData.googleAdsEnabled ? (marketingData.googleAds.uniqueLeads || 0) : 0;
    const lsaLeads = hasLsaProduct && marketingData.lsaEnabled ? (marketingData.lsa.uniqueLeads || 0) : 0;
    const otherLeads = marketingData.otherLeads?.count || 0;
    return gbpLeads + googleAdsLeads + lsaLeads + otherLeads;
  }, [marketingData.gbpLocations, marketingData.googleAds.uniqueLeads, marketingData.lsa.uniqueLeads, marketingData.googleAdsEnabled, marketingData.lsaEnabled, hasGbpProduct, hasGoogleAdsProduct, hasLsaProduct, marketingData.otherLeads?.count]);

  // Task #4511 — mirror of publicReport/derive.ts: the auto-calculated total
  // counts webinar in LEAD EQUIVALENTS (breakdown mode: ceil(count × 1.6);
  // fallback mode webinarLeadEquiv === webinarLeadCount, unchanged), so the
  // reference display, the persisted marketing.totalLeads, and the persisted
  // missed-call-rate denominator (Task #2680, hideOtherLeads applied
  // symmetrically) agree with what the public report derives live. The Other
  // bucket stays raw-included here per the Task #2760 invariant.
  const calculatedTotalLeads = totalLeadsExcludingWebinar + webinarLeadEquiv;

  // Lead source breakdown for pie chart
  const leadSourceBreakdown = useMemo(() => {
    const gbpLeads = hasGbpProduct ? marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.uniqueLeads || 0), 0) : 0;
    const googleAdsLeads = hasGoogleAdsProduct && marketingData.googleAdsEnabled ? (marketingData.googleAds.uniqueLeads || 0) : 0;
    const lsaLeads = hasLsaProduct && marketingData.lsaEnabled ? (marketingData.lsa.uniqueLeads || 0) : 0;
    const otherLeads = marketingData.otherLeads?.count || 0;
    const sources: Array<{name: string; value: number; color: string; isWebinar?: boolean}> = [];
    if (gbpLeads > 0) sources.push({ name: "GBP", value: gbpLeads, color: LEAD_SOURCE_COLORS.gbp });
    if (googleAdsLeads > 0) sources.push({ name: "Google Ads", value: googleAdsLeads, color: LEAD_SOURCE_COLORS.googleAds });
    if (lsaLeads > 0) sources.push({ name: "LSA", value: lsaLeads, color: LEAD_SOURCE_COLORS.lsa });
    if (webinarLeadEquiv > 0) sources.push({ name: "Webinar", value: webinarLeadEquiv, color: LEAD_SOURCE_COLORS.webinar, isWebinar: true });
    if (otherLeads > 0) sources.push({ name: "Other", value: otherLeads, color: LEAD_SOURCE_COLORS.other });
    
    const total = sources.reduce((sum, s) => sum + s.value, 0);
    return { sources, total };
  }, [marketingData.gbpLocations, marketingData.googleAds.uniqueLeads, marketingData.lsa.uniqueLeads, marketingData.googleAdsEnabled, marketingData.lsaEnabled, hasGbpProduct, hasGoogleAdsProduct, hasLsaProduct, webinarLeadEquiv, marketingData.otherLeads?.count]);

  // Auto-calculated lead quality from all sources (respects product purchases)
  const calculatedLeadQuality = useMemo(() => {
    let good = 0, notQuotable = 0, missedCalls = 0, noData = 0;
    
    if (hasGbpProduct) {
      good += marketingData.leadQuality?.good || 0;
      notQuotable += marketingData.leadQuality?.notQuotable || 0;
      missedCalls += marketingData.leadQuality?.missedCalls || 0;
      noData += marketingData.leadQuality?.noData || 0;
    }
    
    if (hasGoogleAdsProduct && marketingData.googleAdsEnabled) {
      good += marketingData.googleAds.leadQuality?.good || 0;
      notQuotable += marketingData.googleAds.leadQuality?.notQuotable || 0;
      missedCalls += marketingData.googleAds.leadQuality?.missedCalls || 0;
      noData += marketingData.googleAds.leadQuality?.noData || 0;
    }
    
    if (hasLsaProduct && marketingData.lsaEnabled) {
      good += marketingData.lsa.leadQuality?.good || 0;
      notQuotable += marketingData.lsa.leadQuality?.notQuotable || 0;
      missedCalls += marketingData.lsa.leadQuality?.missedCalls || 0;
      noData += marketingData.lsa.leadQuality?.noData || 0;
    }
    
    if (hasWebinarProduct) {
      if (hasWebinarLeadQuality) {
        good += marketingData.webinar?.leadQuality?.good || 0;
        notQuotable += marketingData.webinar?.leadQuality?.notQuotable || 0;
        missedCalls += marketingData.webinar?.leadQuality?.missedCalls || 0;
        noData += marketingData.webinar?.leadQuality?.noData || 0;
      } else {
        good += marketingData.webinar?.hotTransfers || 0;
      }
    }
    
    if (marketingData.otherLeads?.leadQuality) {
      good += marketingData.otherLeads.leadQuality.good || 0;
      notQuotable += marketingData.otherLeads.leadQuality.notQuotable || 0;
      missedCalls += marketingData.otherLeads.leadQuality.missedCalls || 0;
      noData += marketingData.otherLeads.leadQuality.noData || 0;
    }
    
    return { good, notQuotable, missedCalls, noData };
  }, [marketingData.leadQuality, marketingData.googleAds, marketingData.lsa, marketingData.googleAdsEnabled, marketingData.lsaEnabled, marketingData.webinar?.leadQuality, marketingData.webinar?.hotTransfers, hasGbpProduct, hasGoogleAdsProduct, hasLsaProduct, hasWebinarProduct, hasWebinarLeadQuality, marketingData.otherLeads?.leadQuality]);

  const leadQualityExcludingWebinar = useMemo(() => {
    const wGood = hasWebinarProduct
      ? (hasWebinarLeadQuality ? (marketingData.webinar?.leadQuality?.good || 0) : (marketingData.webinar?.hotTransfers || 0))
      : 0;
    const wNotQuotable = hasWebinarProduct && hasWebinarLeadQuality ? (marketingData.webinar?.leadQuality?.notQuotable || 0) : 0;
    const wMissed = hasWebinarProduct && hasWebinarLeadQuality ? (marketingData.webinar?.leadQuality?.missedCalls || 0) : 0;
    const wNoData = hasWebinarProduct && hasWebinarLeadQuality ? (marketingData.webinar?.leadQuality?.noData || 0) : 0;
    return {
      good: calculatedLeadQuality.good - wGood,
      notQuotable: calculatedLeadQuality.notQuotable - wNotQuotable,
      missedCalls: calculatedLeadQuality.missedCalls - wMissed,
      noData: calculatedLeadQuality.noData - wNoData,
    };
  }, [calculatedLeadQuality, hasWebinarProduct, hasWebinarLeadQuality, marketingData.webinar?.leadQuality, marketingData.webinar?.hotTransfers]);

  // Lead to consult rate (depends on calculatedTotalLeads)
  const leadToConsultRate = useMemo(() => {
    if (calculatedTotalLeads === 0) return 0;
    return Math.round((intakeData.totalConsults / calculatedTotalLeads) * 1000) / 10;
  }, [calculatedTotalLeads, intakeData.totalConsults]);

  // Task #4983 — the ONE missed-call-rate resolution for this form: the
  // hideOtherLeads-symmetric lead set (Task #2680) through the shared
  // three-tier resolver, source-labeled. The editor preview renders it and
  // saveIntake persists it, so the preview can never show a rate the save
  // would not write (e.g. a hidden-Other client whose only missed calls sit
  // in the Other bucket previews "No data", exactly what save resolves).
  const missedCallPreview = useMemo(() => {
    const mcAdjusted = applyHideOtherLeads({
      missedCalls: calculatedLeadQuality.missedCalls,
      totalLeads: calculatedTotalLeads,
      otherMissedCalls: marketingData.otherLeads?.leadQuality?.missedCalls || 0,
      otherLeadCount: marketingData.otherLeads?.count || 0,
      hideOtherLeads: selectedClient?.hideOtherLeads === true,
    });
    return resolveMissedCallRateWithSource({
      bucketMissedCalls: mcAdjusted.missedCalls,
      totalLeads: mcAdjusted.totalLeads,
      storedRate: intakeData.missedCallRate,
    });
  }, [calculatedLeadQuality.missedCalls, calculatedTotalLeads, marketingData.otherLeads?.leadQuality?.missedCalls, marketingData.otherLeads?.count, selectedClient?.hideOtherLeads, intakeData.missedCallRate]);

  const dataAccessMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (dataAccess) {
      dataAccess.forEach(item => {
        map[item.category] = item.status;
      });
    }
    return map;
  }, [dataAccess]);

  // Task #2418 — labels come from the shared source of truth and the
  // not-available categories are split into two treatments:
  //   detected (data flowing) → soft "mark Available?" confirm prompt;
  //   critical (genuinely absent / can't tell) → red critical warning.
  const { detected: detectedDataCategories, critical: criticalMissingCategories } = useMemo(
    () => classifyDataAccessForReport(dataAccessMap, dataAccessDetection),
    [dataAccessMap, dataAccessDetection],
  );

  const { data: existingReport } = useQuery<Report & {
    sections: any[];
    // Task #4537 — presenter identity resolved by GET /api/reports/:id for
    // the "Presented / Delivered" caption.
    presentedByUser?: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  }>({
    queryKey: ["/api/reports", activeReportId],
    queryFn: async () => {
      const res = await fetch(`/api/reports/${activeReportId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch report");
      return res.json();
    },
    enabled: !!activeReportId && !!user,
  });

  const getSectionMeta = useCallback((sectionKey: string): {
    lastEditedBy: string | null;
    lastEditSource: string | null;
    lastEditAt: string | null;
    lastEditedByUser: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null;
  } => {
    const section: any = existingReport?.sections?.find((s: any) => s.sectionKey === sectionKey);
    return {
      lastEditedBy: section?.lastEditedBy ?? null,
      lastEditSource: section?.lastEditSource ?? null,
      lastEditAt: section?.lastEditAt ?? null,
      lastEditedByUser: section?.lastEditedByUser ?? null,
    };
  }, [existingReport]);

  // Seed GBP locations from the client's command panel. Two cases:
  //  1. Brand-new report (no activeReportId): seed once per (mount, clientId).
  //     Switching the client picker before saving correctly clears the previous
  //     client's rows and seeds the new client's rows once.
  //  2. Existing report whose loaded gbpLocations is empty AND the client has
  //     the GBP product AND the client has locations configured. This covers
  //     the "report created before locations were set up" case (e.g. a draft
  //     whose marketing section was never edited, or one saved with an empty
  //     gbp.locations array because the client had none at the time). Without
  //     this fallback the form shows "No GBP locations configured" forever even
  //     after the operator adds the locations in Client Management.
  //
  // We never overwrite a non-empty saved gbpLocations array — operators may
  // have intentionally pruned rows. We also wait for the existing-report data
  // load to finish (`dataLoadedForReportId === existingReport.id`) before
  // seeding case (2), so we don't race the load and clobber saved data.
  const seededClientIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!formData.clientId) return;
    if (!clientLocations) return; // wait until the locations query has loaded

    if (activeReportId) {
      // Case (2): existing report. Only auto-seed when the loaded report has
      // an empty gbpLocations array AND the client owns GBP AND there is at
      // least one configured location AND we've already finished loading
      // this report's saved data.
      if (!existingReport || dataLoadedForReportId !== existingReport.id) return;
      if (marketingData.gbpLocations.length > 0) return;
      if (clientLocations.length === 0) return;
      const ownsGbp = (clientProducts || []).includes("gbp");
      if (!ownsGbp) return;
      // Use a per-report sentinel so we only seed once per opened report.
      if (seededClientIdRef.current === `report:${activeReportId}`) return;
      seededClientIdRef.current = `report:${activeReportId}`;
    } else {
      // Case (1): new report. Seed once per (mount, clientId).
      if (seededClientIdRef.current === formData.clientId) return;
      seededClientIdRef.current = formData.clientId;
    }

    const seeded = clientLocations.map(loc => ({
      id: loc.id,
      name: loc.name,
      uniqueLeads: 0,
      reviewsGenerated: 0,
      reviewsRespondedTo: 0,
      postsQaCount: 0,
      leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
    }));
    setMarketingData(prev => ({ ...prev, gbpLocations: seeded }));
  }, [
    clientLocations,
    activeReportId,
    formData.clientId,
    existingReport,
    dataLoadedForReportId,
    marketingData.gbpLocations.length,
    clientProducts,
  ]);

  // Stable primitive signature of the GBP locations still missing heatmap
  // snapshots, so the auto-pull effect below re-fires only when that set
  // changes — not on every gbpLocations reference change from unrelated edits.
  const gbpLocationIdsNeedingHeatmaps = useMemo(
    () =>
      marketingData.gbpLocations
        .filter(loc => !loc.heatmapSnapshotIds?.length && !loc.heatmapSnapshotId)
        .map(loc => loc.id)
        .join(","),
    [marketingData.gbpLocations],
  );

  useEffect(() => {
    if (!formData.clientId || !formData.reportMonth || gbpLocationIdsNeedingHeatmaps === "") return;

    let cancelled = false;
    void (async () => { // fire-and-forget: effect-scoped fetch, cancelled flag guards state writes
      try {
        const res = await fetch(
          `/api/clients/${formData.clientId}/heatmap-snapshots-for-month?month=${formData.reportMonth}`,
          { credentials: "include" }
        );
        if (!res.ok || cancelled) return;
        const mapping: Record<string, string[]> = await res.json();
        if (cancelled) return;

        if (Object.keys(mapping).length > 0) {
          setMarketingData(prev => {
            let changed = false;
            const updated = prev.gbpLocations.map(loc => {
              if (loc.heatmapSnapshotIds?.length || loc.heatmapSnapshotId) return loc;
              const ids = mapping[loc.id];
              if (!ids || ids.length === 0) return loc;
              changed = true;
              return { ...loc, heatmapSnapshotIds: ids, heatmapSnapshotId: ids[0] };
            });
            if (!changed) return prev;
            return { ...prev, gbpLocations: updated };
          });
        }
      } catch (e) {
        console.error("[ReportForm] Failed to auto-pull heatmap snapshots:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [formData.clientId, formData.reportMonth, gbpLocationIdsNeedingHeatmaps]);

  // Load existing report data - only once per report ID to prevent overwriting user edits
  useEffect(() => {
    // Only load data if we haven't loaded it for this report yet
    if (existingReport && existingReport.id !== dataLoadedForReportId) {
      setDataLoadedForReportId(existingReport.id);
      
      setFormData({
        clientId: existingReport.clientId,
        reportMonth: existingReport.reportMonth,
        status: existingReport.status,
        hideLeadQuality: existingReport.hideLeadQuality || false,
        presented: !!existingReport.presentedAt,
      });
      
      const intakeSection = existingReport.sections?.find(s => s.sectionKey === "intake");
      if (intakeSection?.data) {
        setIntakeData({
          totalConsults: intakeSection.data.totalConsults || 0,
          missedCallRate: intakeSection.data.missedCallRate || 0,
          avgTimeToAnswer: intakeSection.data.avgTimeToAnswer || 0,
          qualityScore: intakeSection.data.qualityScore || 0,
          commonIssues: intakeSection.data.commonIssues || "",
          noDataFlags: intakeSection.data.noDataFlags || { totalConsults: false, avgTimeToAnswer: false, qualityScore: false },
        });
      }
      
      const salesSection = existingReport.sections?.find(s => s.sectionKey === "sales");
      if (salesSection?.data) {
        setSalesData({
          totalCases: salesSection.data.totalCases || 0,
          averageCaseValue: salesSection.data.averageCaseValue || 0,
          noShowRate: salesSection.data.noShowRate || 0,
          avgFollowUps: salesSection.data.avgFollowUps || 0,
          qualityScore: salesSection.data.qualityScore || 0,
          commonIssues: salesSection.data.commonIssues || "",
          dealTouchDensity: salesSection.data.dealTouchDensity || 0,
          avgAgeOpenMatters: salesSection.data.avgAgeOpenMatters || 0,
          pipelineMomentumScore: salesSection.data.pipelineMomentumScore || 0,
          noDataFlags: salesSection.data.noDataFlags || { totalCases: false, averageCaseValue: false, noShowRate: false, avgFollowUps: false, qualityScore: false, dealTouchDensity: false, avgAgeOpenMatters: false, pipelineMomentumScore: false },
        });
      }

      // Task #3769 — hydrate the broken-source import warning banner from the
      // per-section keys the import paths persist. An operator save omits the
      // key server-side, so a reload after addressing it clears the banner.
      const bsIntake: any = intakeSection?.data?.brokenSourceImportWarning;
      const bsSales: any = salesSection?.data?.brokenSourceImportWarning;
      if (bsIntake || bsSales) {
        setBrokenSourceWarning({
          missingMetrics: [
            ...(Array.isArray(bsIntake?.missingMetrics) ? bsIntake.missingMetrics : []),
            ...(Array.isArray(bsSales?.missingMetrics) ? bsSales.missingMetrics : []),
          ],
          placeholderSections: [
            ...(bsIntake?.rawPlaceholder ? ["intake"] : []),
            ...(bsSales?.rawPlaceholder ? ["sales"] : []),
          ],
          priorReportMonth: bsIntake?.priorReportMonth ?? bsSales?.priorReportMonth ?? null,
        });
      } else {
        setBrokenSourceWarning(null);
      }

      // Capture section timestamps for concurrency control
      const timestamps: Record<string, string> = {};
      existingReport.sections?.forEach((s: any) => {
        if (s.updatedAt) {
          timestamps[s.sectionKey] = s.updatedAt;
        }
      });
      setSectionTimestamps(timestamps);

      // Task #4273 — hydrate slide verdicts from the internal section row
      // (the authed GET /api/reports/:id serves every stored row, including
      // internal ones — only the public/share builders strip them).
      const verdictsSection = existingReport.sections?.find(s => s.sectionKey === "slideVerdicts");
      const hydratedVerdicts = sanitizeSlideVerdictMap((verdictsSection?.data as any)?.verdicts);
      setVerdictsData(hydratedVerdicts);
      setVerdictsSavedJson(JSON.stringify(hydratedVerdicts));

      const marketingSection = existingReport.sections?.find(s => s.sectionKey === "marketing");
      if (marketingSection?.data) {
        setMarketingData({
          totalLeads: marketingSection.data.totalLeads || 0,
          posture: marketingSection.data.posture || "",
          leadQuality: marketingSection.data.gbpLeadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          gbpLocations: (marketingSection.data.gbp?.locations || []).map((loc: any) => ({
            ...loc,
            heatmapSnapshotIds: loc.heatmapSnapshotIds?.length
              ? loc.heatmapSnapshotIds
              : loc.heatmapSnapshotId
                ? [loc.heatmapSnapshotId]
                : [],
          })),
          blogPostUrl: marketingSection.data.gbp?.shared?.blogPostUrl || "",
          googleAdsEnabled: marketingSection.data.googleAdsEnabled !== false,
          lsaEnabled: marketingSection.data.lsaEnabled !== false,
          googleAds: marketingSection.data.googleAds || { uniqueLeads: 0, adSpend: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } },
          lsa: marketingSection.data.lsa || { uniqueLeads: 0, adSpend: 0, leadQuality: { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } },
          webinar: {
            registrants: (marketingSection.data.webinar || marketingSection.data.webinars)?.registrants || 0,
            attendees: (marketingSection.data.webinar || marketingSection.data.webinars)?.attendees || 0,
            hotTransfers: (marketingSection.data.webinar || marketingSection.data.webinars)?.hotTransfers || 0,
            leadQuality: (marketingSection.data.webinar || marketingSection.data.webinars)?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          },
          reviewGeneration: {
            listContacted: marketingSection.data.reviewGeneration?.list?.contacted || 0,
            listReviews: marketingSection.data.reviewGeneration?.list?.reviews || 0,
            webinarReviews: marketingSection.data.reviewGeneration?.webinar?.reviews || 0,
            otherCount: marketingSection.data.reviewGeneration?.other?.count || 0,
            totalReviews: marketingSection.data.reviewGeneration?.totalReviews || 0,
            monthlyTarget: marketingSection.data.reviewGeneration?.monthlyTarget || 0,
          },
          otherLeads: {
            count: marketingSection.data.otherLeads?.count || 0,
            description: marketingSection.data.otherLeads?.description || "",
            leadQuality: marketingSection.data.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
          },
        });

        // Task #2594 — an unattended webhook PDF import (Task #2568) stores any
        // parsed GBP locations that did NOT resolve to the client's command
        // panel under `marketing.gbpUnresolvedImports` (objects with a `name`)
        // instead of minting ghost rows. Surface them through the same amber
        // banner the manual import flow uses so operators see them without
        // reading server logs. Re-saving the report (the save payload omits this
        // key) clears it once the operator has acted.
        const persistedUnresolvedGbp: string[] = Array.isArray(marketingSection.data.gbpUnresolvedImports)
          ? marketingSection.data.gbpUnresolvedImports
              .map((u: any) => (typeof u === "string" ? u : u?.name))
              .filter((n: any): n is string => typeof n === "string" && n.trim().length > 0)
          : [];
        if (persistedUnresolvedGbp.length > 0) {
          setUnresolvedGbpImports(persistedUnresolvedGbp);
        }
      }

      const actionsSection = existingReport.sections?.find(s => s.sectionKey === "nextActions");
      if (actionsSection?.data) {
        setNextActionsData({
          ours: actionsSection.data.ours || [],
          theirs: actionsSection.data.theirs || [],
          notes: actionsSection.data.notes || "",
          showNotes: actionsSection.data.showNotes || false,
          // Task #4282 — strict boolean; absent on pre-#4282 rows = hidden.
          showExpansionQuestion: actionsSection.data.showExpansionQuestion === true,
        });
      }
    }
  }, [existingReport, dataLoadedForReportId]);

  // Load average case value from client if not already set. Seeds at most once
  // per client (ref sentinel), so listing salesData.averageCaseValue as a dep
  // cannot re-seed the field after an operator deliberately zeroes it.
  const caseValueSeededForClientRef = useRef<string | null>(null);
  useEffect(() => {
    if (!formData.clientId || !clients) return;
    if (caseValueSeededForClientRef.current === formData.clientId) return;
    if (salesData.averageCaseValue !== 0) {
      caseValueSeededForClientRef.current = formData.clientId;
      return;
    }
    const client = clients.find(c => c.id === formData.clientId);
    if (client?.averageCaseValue) {
      caseValueSeededForClientRef.current = formData.clientId;
      setSalesData(prev => ({ ...prev, averageCaseValue: client.averageCaseValue! }));
    }
  }, [formData.clientId, clients, salesData.averageCaseValue]);

  // Prefill noDataFlags based on client data access settings (only for new reports without existing data)
  useEffect(() => {
    // Only prefill when: no existing report data loaded, data access is loaded, and we haven't applied prefill for this client yet
    if (!existingReport && dataAccess && dataAccess.length > 0 && formData.clientId && prefillAppliedForClient !== formData.clientId) {
      setPrefillAppliedForClient(formData.clientId);
      
      // Map data access categories to noDataFlags
      const accessMap: Record<string, string> = {};
      dataAccess.forEach(item => {
        accessMap[item.category] = item.status;
      });
      
      // Prefill intake noDataFlags based on consult_bookings access
      if (accessMap.consult_bookings && accessMap.consult_bookings !== "available") {
        setIntakeData(prev => ({
          ...prev,
          noDataFlags: {
            ...prev.noDataFlags,
            totalConsults: true,
            avgTimeToAnswer: true,
            qualityScore: true,
          }
        }));
      }
      
      // Prefill sales noDataFlags based on various access settings
      const salesUpdates: Record<string, boolean> = {};
      if (accessMap.sales_conversions && accessMap.sales_conversions !== "available") {
        salesUpdates.totalCases = true;
        salesUpdates.averageCaseValue = true;
      }
      if (accessMap.no_show_rate && accessMap.no_show_rate !== "available") {
        salesUpdates.noShowRate = true;
      }
      if (accessMap.follow_up_touches && accessMap.follow_up_touches !== "available") {
        salesUpdates.pipelineMomentumScore = true;
      }
      if (accessMap.sales_transcripts && accessMap.sales_transcripts !== "available") {
        salesUpdates.qualityScore = true;
      }
      
      if (Object.keys(salesUpdates).length > 0) {
        setSalesData(prev => ({
          ...prev,
          noDataFlags: {
            ...prev.noDataFlags,
            ...salesUpdates,
          }
        }));
      }
    }
  }, [dataAccess, existingReport, formData.clientId, prefillAppliedForClient]);

  // Default the report month exactly once, on mount, for brand-new reports.
  // The ref keeps the original mount-only semantics while the deps satisfy
  // exhaustive-deps; without it, clearing the month field on a new report
  // would snap back to the current month.
  const defaultMonthAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultMonthAppliedRef.current) return;
    defaultMonthAppliedRef.current = true;
    if (!formData.reportMonth && !params.id && !activeReportId) {
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      setFormData(prev => ({ ...prev, reportMonth: currentMonth }));
    }
  }, [formData.reportMonth, params.id, activeReportId]);

  // Auto-save after heatmap upload - this runs after the state has updated.
  // saveMarketing is a plain function recreated every render, so the effect
  // reads it through a latest-value ref instead of depending on it directly.
  const saveMarketingRef = useRef<((isAutosave?: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    saveMarketingRef.current = saveMarketing;
  });
  useEffect(() => {
    if (pendingHeatmapSave && activeReportId) {
      // Clear the pending save first to prevent re-triggering
      setPendingHeatmapSave(null);
      // Now trigger the save
      saveMarketingRef.current?.();
    }
  }, [pendingHeatmapSave, activeReportId]);

  const importFieldDefinitions = useMemo(() => [
    { key: "reportMonth", label: "Report Month", section: "General", format: (v: any) => v || "Not detected" },
    { key: "clientName", label: "Client Name", section: "General", format: (v: any) => v || "Not detected" },
    { key: "marketing.totalLeads", label: `Total ${t("leads")} (reference - auto-calculated from sources)`, section: "Marketing", format: (v: any) => v?.toString() || "0" },
    { key: "marketing.leadQuality", label: `Overall ${t("leads")} Quality (reference - auto-calculated from sources)`, section: "Marketing",
      format: (v: any) => v ? `${v.good}G / ${v.notQuotable}NQ / ${v.missedCalls}M / ${v.noData}ND` : "Not detected" },
    { key: "marketing.gbpLocations", label: "GBP Locations", section: "Marketing",
      format: (v: any) => v?.length ? v.map((l: any) => `${l.name} (${l.uniqueLeads} ${t("leads").toLowerCase()})`).join(", ") : "None found" },
    { key: "marketing.googleAds", label: `Google Ads (${t("leads")} / Spend)`, section: "Marketing",
      format: (v: any) => v?.uniqueLeads ? `${v.uniqueLeads} ${t("leads").toLowerCase()} / $${v.adSpend?.toLocaleString()}` : "Not detected" },
    { key: "marketing.lsa", label: `LSA (${t("leads")} / Spend)`, section: "Marketing",
      format: (v: any) => v?.uniqueLeads ? `${v.uniqueLeads} ${t("leads").toLowerCase()} / $${v.adSpend?.toLocaleString()}` : "Not detected" },
    { key: "marketing.googleAds.leadQuality", label: `Google Ads ${t("leads")} Quality`, section: "Marketing",
      format: (v: any) => v?.good ? `${v.good}G / ${v.notQuotable}NQ / ${v.missedCalls}M` : "Not detected" },
    { key: "marketing.lsa.leadQuality", label: `LSA ${t("leads")} Quality`, section: "Marketing",
      format: (v: any) => v?.good ? `${v.good}G / ${v.notQuotable}NQ / ${v.missedCalls}M` : "Not detected" },
    { key: "marketing.webinar", label: "Webinars (Registrants / Attendees / Hot Transfers)", section: "Marketing",
      format: (v: any) => v?.registrants ? `${v.registrants} reg / ${v.attendees} att / ${v.hotTransfers} HT` : "Not detected" },
    { key: "marketing.reviewGeneration", label: "Review Generation", section: "Marketing",
      format: (v: any) => v?.listContacted ? `${v.listContacted} contacted / ${v.listReviews} list / ${v.webinarReviews} webinar / ${v.otherCount} other` : "Not detected" },
    { key: "marketing.otherLeads", label: `Other ${t("leads")} (Social / Direct / Referral)`, section: "Marketing",
      format: (v: any) => v?.total ? `${v.socialMedia} social / ${v.directCalls} direct / ${v.referrals} referral` : "Not detected" },
    { key: "intake.totalConsults", label: `Total ${t("consults")}`, section: "Intake", format: (v: any) => v?.toString() || "0" },
    { key: "intake.missedCallRate", label: t("missedCallRate"), section: "Intake", format: (v: any) => v ? `${v}%` : "Not detected" },
    { key: "intake.avgTimeToAnswer", label: "Avg Time to Human Answer (sec)", section: "Intake", format: (v: any) => v?.toString() || "0" },
    { key: "intake.qualityScore", label: "Intake Raw Quality Score", section: "Intake", format: (v: any) => v?.toString() || "0" },
    { key: "intake.commonIssues", label: "Intake Common Issues", section: "Intake",
      format: (v: any) => v ? (v.length > 80 ? v.substring(0, 80) + "..." : v) : "Not detected" },
    { key: "sales.totalCases", label: `Total ${t("cases")}`, section: "Sales", format: (v: any) => v?.toString() || "0" },
    { key: "sales.averageCaseValue", label: t("averageCaseValue"), section: "Sales", format: (v: any) => v ? `$${v.toLocaleString()}` : "$0" },
    { key: "sales.revenue", label: "Top-Line Revenue", section: "Sales", format: (v: any) => v ? `$${v.toLocaleString()}` : "Not detected" },
    { key: "sales.noShowRate", label: t("noShowRate"), section: "Sales", format: (v: any) => v ? `${v}%` : "0%" },
    { key: "sales.pipelineMomentumScore", label: "Pipeline Momentum Index", section: "Sales", format: (v: any) => v?.toString() || "0" },
    { key: "sales.qualityScore", label: "Sales Raw Quality Score", section: "Sales", format: (v: any) => v?.toString() || "0" },
    { key: "sales.dealTouchDensity", label: "Active Deal Touch Density", section: "Sales", format: (v: any) => v ? v.toString() : "0" },
    { key: "sales.avgAgeOpenMatters", label: "Avg Age of Open Matters", section: "Sales", format: (v: any) => v ? v.toString() : "0" },
    { key: "sales.commonIssues", label: "Sales Common Issues", section: "Sales",
      format: (v: any) => v ? (v.length > 80 ? v.substring(0, 80) + "..." : v) : "Not detected" },
  ], [t]);

  const getFieldValue = useCallback((data: any, key: string) => {
    const parts = key.split(".");
    let val = data;
    for (const part of parts) {
      if (val == null) return undefined;
      val = val[part];
    }
    return val;
  }, []);

  const getFieldConfidenceSource = useCallback((data: any, key: string): string | undefined => {
    const fc = data?.fieldConfidence;
    if (!fc) return undefined;
    if (fc[key]?.source) return fc[key].source;
    const prefix = key.split(".").slice(0, -1).join(".");
    if (prefix && fc[prefix]?.source) return fc[prefix].source;
    return undefined;
  }, []);

  const getFieldConfidence = useCallback((data: any, key: string): "high" | "medium" | "low" => {
    const fc = data?.fieldConfidence;
    // Treat the parser's `"none"` confidence (empty / placeholder / not found)
    // the same as `"low"` for UI display so importers don't see a green check
    // next to a blank field.
    const normalize = (c: string | undefined): "high" | "medium" | "low" =>
      c === "high" || c === "medium" ? c : "low";
    if (!fc) return "low";
    if (fc[key]) return normalize(fc[key].confidence);
    const prefix = key.split(".").slice(0, -1).join(".");
    if (prefix && fc[prefix]) return normalize(fc[prefix].confidence);
    const val = getFieldValue(data, key);
    if (val === 0 || val === "" || val === undefined || val === null) return "low";
    if (Array.isArray(val) && val.length === 0) return "low";
    if (typeof val === "object" && !Array.isArray(val)) {
      const hasValues = Object.values(val).some(v => typeof v === "number" ? v > 0 : !!v);
      return hasValues ? "medium" : "low";
    }
    return "medium";
  }, [getFieldValue]);

  const hasFieldValue = useCallback((data: any, key: string): boolean => {
    const val = getFieldValue(data, key);
    if (val === 0 || val === "" || val === undefined || val === null) return false;
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === "object") return Object.values(val).some(v => typeof v === "number" ? v > 0 : !!v);
    return true;
  }, [getFieldValue]);

  // Build a snapshot of the CURRENT in-form state shaped like the parser
  // output, so the import-review modal can show a real diff (existing vs
  // PDF) and default-check only the fields that actually changed. Used by
  // both the initial import and the manual reimport flows.
  const buildCurrentSnapshot = useCallback(() => {
    const selectedClientName = clients?.find((c: Client) => c.id === formData.clientId)?.firmName || "";
    return {
      reportMonth: formData.reportMonth,
      clientName: selectedClientName,
      marketing: {
        totalLeads: marketingData.totalLeads,
        leadQuality: marketingData.leadQuality,
        gbpLocations: (marketingData.gbpLocations || []).map(loc => ({
          name: loc.name,
          uniqueLeads: loc.uniqueLeads,
          reviewsGenerated: loc.reviewsGenerated,
          reviewsRespondedTo: loc.reviewsRespondedTo,
          postsQaCount: loc.postsQaCount,
          leadQuality: loc.leadQuality,
        })),
        googleAds: marketingData.googleAds,
        lsa: marketingData.lsa,
        webinar: marketingData.webinar,
        reviewGeneration: {
          listContacted: marketingData.reviewGeneration?.listContacted || 0,
          listReviews: marketingData.reviewGeneration?.listReviews || 0,
          webinarReviews: marketingData.reviewGeneration?.webinarReviews || 0,
          otherCount: marketingData.reviewGeneration?.otherCount || 0,
          totalReviews: marketingData.reviewGeneration?.totalReviews || 0,
          monthlyTarget: marketingData.reviewGeneration?.monthlyTarget || 0,
        },
        otherLeads: {
          total: marketingData.otherLeads?.count || 0,
          socialMedia: 0,
          directCalls: 0,
          referrals: 0,
        },
        blogPostUrl: marketingData.blogPostUrl,
      },
      intake: {
        totalConsults: intakeData.totalConsults,
        missedCallRate: intakeData.missedCallRate,
        avgTimeToAnswer: intakeData.avgTimeToAnswer,
        qualityScore: intakeData.qualityScore,
        commonIssues: intakeData.commonIssues,
      },
      sales: {
        totalCases: salesData.totalCases,
        averageCaseValue: salesData.averageCaseValue,
        noShowRate: salesData.noShowRate,
        pipelineMomentumScore: salesData.pipelineMomentumScore,
        qualityScore: salesData.qualityScore,
        dealTouchDensity: salesData.dealTouchDensity,
        avgAgeOpenMatters: salesData.avgAgeOpenMatters,
        commonIssues: salesData.commonIssues,
      },
    };
  }, [formData, clients, marketingData, intakeData, salesData]);

  // Deep equality check used to decide whether a parsed field actually
  // differs from the current saved value. Treats null/undefined/0/"" as
  // equivalent so cosmetic shape differences don't show up as diffs.
  const valuesEqual = useCallback((a: any, b: any): boolean => {
    const norm = (v: any) => (v === undefined || v === null ? 0 : v);
    if (typeof a === "number" || typeof b === "number") return norm(a) === norm(b);
    if (typeof a === "string" || typeof b === "string") return (a || "").trim() === (b || "").trim();
    if (Array.isArray(a) || Array.isArray(b)) {
      const aa = a || [], bb = b || [];
      if (aa.length !== bb.length) return false;
      return aa.every((item: any, i: number) => valuesEqual(item, bb[i]));
    }
    if (typeof a === "object" || typeof b === "object") {
      const aa = a || {}, bb = b || {};
      const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
      for (const k of keys) if (!valuesEqual(aa[k], bb[k])) return false;
      return true;
    }
    return norm(a) === norm(b);
  }, []);

  // PDF Import handler - parses PDF and opens review dialog
  const handlePdfImport = async (file: File) => {
    setIsImporting(true);
    try {
      const formDataUpload = new FormData();
      formDataUpload.append('pdf', file);
      
      const res = await fetch('/api/reports/import-pdf', {
        method: 'POST',
        credentials: 'include',
        body: formDataUpload,
      });
      
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || 'Failed to parse PDF');
      }
      
      const parsed = await res.json();
      logActivity("import", "Imported PDF report data");
      setPendingImportData(parsed);
      
      const selections: Record<string, boolean> = {};
      for (const field of importFieldDefinitions) {
        const hasVal = hasFieldValue(parsed, field.key);
        const isReferenceOnly = field.key === "marketing.leadQuality" || field.key === "marketing.totalLeads";
        // Task #3772 — a numeric metric with no parse evidence must start
        // unchecked (hasVal is already false for its defaulted 0; this guard
        // also covers any future non-zero default).
        selections[field.key] = isReferenceOnly || importMetricNotFound(parsed, field.key) ? false : hasVal;
      }
      setWebinarConflictFlagged(false);
      setImportFieldSelections(selections);
      setShowImportReview(true);
    } catch (error: any) {
      console.error('PDF import error:', error);
      toast({ title: error?.message || 'Failed to import PDF', variant: 'destructive' });
    } finally {
      setIsImporting(false);
    }
  };

  const handleReimport = async (file?: File) => {
    if (!activeReportId) return;
    setIsReimporting(true);
    try {
      let res: Response;
      if (file) {
        const formDataUpload = new FormData();
        formDataUpload.append('pdf', file);
        res = await fetch(`/api/reports/${activeReportId}/reimport`, {
          method: 'POST',
          credentials: 'include',
          body: formDataUpload,
        });
      } else {
        res = await fetch(`/api/reports/${activeReportId}/reimport`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromStoredUrl: true }),
        });
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error || 'Failed to reimport PDF');
      }

      const result = await res.json();
      setPendingImportData(result.parsed);
      // Task #3769 — immediate broken-source banner; the server also
      // persisted (or cleared) the per-section warning keys, so this stays
      // in sync with what a reload would show.
      setBrokenSourceWarning(result.importWarnings ?? null);

      // Reimport policy: default-check ONLY fields where the PDF value
      // differs from the current saved value. The user explicitly
      // requested per-field consent before overwriting existing data.
      // We compare parsed vs current DIRECTLY (not via hasFieldValue),
      // so that legitimate zero/empty overwrites (e.g. 5 -> 0, "x" -> "")
      // and zero -> non-zero changes are correctly pre-checked. Only
      // fields the parser didn't return at all (undefined path) are skipped.
      const current = buildCurrentSnapshot();
      const webinarConflict = !!result.reconciliation?.webinarLeadQualityDiffers;
      const selections: Record<string, boolean> = {};
      for (const field of importFieldDefinitions) {
        const isReferenceOnly = field.key === "marketing.leadQuality" || field.key === "marketing.totalLeads";
        const parsedVal = getFieldValue(result.parsed, field.key);
        const currentVal = getFieldValue(current, field.key);
        if (isReferenceOnly || parsedVal === undefined) {
          selections[field.key] = false;
          continue;
        }
        // Task #3772 — a numeric metric the parser did NOT find arrives as a
        // defaulted 0 with no fieldConfidence entry. The differs-from-current
        // rule below would otherwise pre-CHECK it against any non-zero saved
        // value, defaulting the operator into overwriting real data with a
        // fabricated zero (e.g. saved 8.45 vs unparsed "Time to Human
        // Answer" → 0). Not-found metrics always start unchecked.
        if (importMetricNotFound(result.parsed, field.key)) {
          selections[field.key] = false;
          continue;
        }
        selections[field.key] = !valuesEqual(parsedVal, currentVal);
      }
      // Task #2852 — when the server flags that the PDF's webinar Lead
      // Quality breakdown differs from the saved (possibly hand-corrected)
      // one, start the Webinars row UNCHECKED so keeping the operator's
      // edits is the default and applying the parsed breakdown requires an
      // explicit opt-in. The conflict is also badged inline on the row.
      if (webinarConflict) {
        selections["marketing.webinar"] = false;
      }
      setWebinarConflictFlagged(webinarConflict);
      setImportFieldSelections(selections);
      setShowImportReview(true);

      // Task #2842 — keep the toast as a secondary heads-up; the primary
      // surface is now the inline warning + pre-unchecked row (Task #2852).
      if (webinarConflict) {
        toast({
          title: 'Webinar breakdown differs from saved edits',
          description: 'The PDF\'s webinar Lead Quality breakdown is different from what\'s currently saved. "Webinars" starts unchecked in the review list — check it only if you want to overwrite your edits.',
          variant: 'destructive',
        });
      }
    } catch (error: any) {
      console.error('Reimport error:', error);
      toast({ title: error?.message || 'Failed to reimport PDF', variant: 'destructive' });
    } finally {
      setIsReimporting(false);
    }
  };

  const applyImportData = useCallback(() => {
    const parsed = pendingImportData;
    if (!parsed) return;
    const sel = importFieldSelections;
    let unresolvedGbpImportNames: string[] = [];

    setImportedData(parsed);

    // Task #3772 — evidence gate: a numeric metric with NO parse evidence
    // (no fieldConfidence entry, defaulted-0 value) must never be written
    // into the form. Selections for such fields are forced off upstream
    // (dialog exclusion + default-unchecked); this guard makes the apply
    // path itself refuse the fabricated zero even if one slips through.
    const selApplied = (dottedKey: string): boolean =>
      !!sel[dottedKey] && !importMetricNotFound(parsed, dottedKey);

    // Task #3772 — reconcile entry-tracked No-Data flags alongside the value
    // writes:
    //  • applying a parsed value clears the field's flag (a stale "No Data"
    //    would otherwise hide the freshly imported value on the report);
    //  • a metric the parse MISSED flips its flag ON when the form holds no
    //    real value, so the eventual save persists an honest "No Data"
    //    instead of an unflagged fabricated 0. Real current values (and
    //    fields the operator left untouched with data) are never flagged.
    const reconcileNoDataFlag = (
      flags: Record<string, boolean>,
      field: string,
      dottedKey: string,
      currentVal: number,
    ): void => {
      if (selApplied(dottedKey)) flags[field] = false;
      else if (importMetricNotFound(parsed, dottedKey) && !(currentVal > 0)) flags[field] = true;
    };
    const flagsChanged = (next: Record<string, boolean>, prevFlags: Record<string, boolean>): boolean =>
      Object.keys(next).some(k => next[k] !== prevFlags[k]);

    const intakeUpdates: any = {};
    if (selApplied("intake.totalConsults")) intakeUpdates.totalConsults = parsed.intake?.totalConsults || 0;
    if (selApplied("intake.missedCallRate")) intakeUpdates.missedCallRate = parsed.intake?.missedCallRate || 0;
    if (selApplied("intake.avgTimeToAnswer")) intakeUpdates.avgTimeToAnswer = parsed.intake?.avgTimeToAnswer || 0;
    if (selApplied("intake.qualityScore")) intakeUpdates.qualityScore = parsed.intake?.qualityScore || 0;
    if (sel["intake.commonIssues"]) intakeUpdates.commonIssues = parsed.intake?.commonIssues || "";
    setIntakeData(prev => {
      const noDataFlags = { ...prev.noDataFlags };
      reconcileNoDataFlag(noDataFlags, "totalConsults", "intake.totalConsults", prev.totalConsults);
      reconcileNoDataFlag(noDataFlags, "avgTimeToAnswer", "intake.avgTimeToAnswer", prev.avgTimeToAnswer);
      reconcileNoDataFlag(noDataFlags, "qualityScore", "intake.qualityScore", prev.qualityScore);
      if (Object.keys(intakeUpdates).length === 0 && !flagsChanged(noDataFlags, prev.noDataFlags)) return prev;
      return { ...prev, ...intakeUpdates, noDataFlags };
    });

    {
      const salesUpdates: any = {};
      if (selApplied("sales.totalCases")) salesUpdates.totalCases = parsed.sales?.totalCases || 0;
      if (selApplied("sales.averageCaseValue")) salesUpdates.averageCaseValue = parsed.sales?.averageCaseValue || 0;
      if (selApplied("sales.revenue") && !selApplied("sales.averageCaseValue") && parsed.sales?.revenue && parsed.sales?.totalCases > 0) {
        salesUpdates.averageCaseValue = Math.round(parsed.sales.revenue / parsed.sales.totalCases);
      }
      if (selApplied("sales.noShowRate")) salesUpdates.noShowRate = parsed.sales?.noShowRate || 0;
      if (selApplied("sales.pipelineMomentumScore")) salesUpdates.pipelineMomentumScore = parsed.sales?.pipelineMomentumScore || 0;
      if (selApplied("sales.qualityScore")) salesUpdates.qualityScore = parsed.sales?.qualityScore || 0;
      if (selApplied("sales.dealTouchDensity")) salesUpdates.dealTouchDensity = parsed.sales?.dealTouchDensity || 0;
      if (selApplied("sales.avgAgeOpenMatters")) salesUpdates.avgAgeOpenMatters = parsed.sales?.avgAgeOpenMatters || 0;
      if (sel["sales.commonIssues"]) salesUpdates.commonIssues = parsed.sales?.commonIssues || "";
      setSalesData(prev => {
        const noDataFlags = { ...prev.noDataFlags };
        reconcileNoDataFlag(noDataFlags, "totalCases", "sales.totalCases", prev.totalCases);
        reconcileNoDataFlag(noDataFlags, "averageCaseValue", "sales.averageCaseValue", prev.averageCaseValue);
        reconcileNoDataFlag(noDataFlags, "noShowRate", "sales.noShowRate", prev.noShowRate);
        reconcileNoDataFlag(noDataFlags, "avgFollowUps", "sales.avgFollowUps", prev.avgFollowUps);
        reconcileNoDataFlag(noDataFlags, "qualityScore", "sales.qualityScore", prev.qualityScore);
        reconcileNoDataFlag(noDataFlags, "dealTouchDensity", "sales.dealTouchDensity", prev.dealTouchDensity);
        reconcileNoDataFlag(noDataFlags, "avgAgeOpenMatters", "sales.avgAgeOpenMatters", prev.avgAgeOpenMatters);
        reconcileNoDataFlag(noDataFlags, "pipelineMomentumScore", "sales.pipelineMomentumScore", prev.pipelineMomentumScore);
        // A revenue-derived averageCaseValue write is real parsed data too.
        if (salesUpdates.averageCaseValue !== undefined) noDataFlags.averageCaseValue = false;
        if (Object.keys(salesUpdates).length === 0 && !flagsChanged(noDataFlags, prev.noDataFlags)) return prev;
        return { ...prev, ...salesUpdates, noDataFlags };
      });
    }

    // Task #2537 — Common Issues arrive already formatted from the server. Both
    // the import-pdf (Task #2475) and reimport routes run the parsed text through
    // the shared formatCommonIssuesContent formatter BEFORE returning, so the
    // 🔴 Issue / ↳ Impact / ➡️ Strategic Fix markdown is already present in
    // `parsed.intake.commonIssues` / `parsed.sales.commonIssues` and is applied
    // to state above. Re-running the client-side formatCommonIssues here would
    // double-process the already-formatted body (a redundant third AI pass that
    // could re-mangle markers and flickers the dialog). The applied text persists
    // via autosave (reimport) or createReportMutation (new report) instead.

    // Task #3858 — the marketing evidence gate. Marketing rows are COMPOSITE
    // objects (googleAds = leads+spend+quality) with no per-metric
    // noDataFlags state, so there is no flag to reconcile — but the same
    // fabricated-zero risk existed at the ROW grain: an all-zero
    // parser-defaulted composite counted as "has value" (its nested
    // leadQuality object is truthy in hasFieldValue) and was PRE-CHECKED in
    // the review dialog, defaulting first uploads into stamping fabricated
    // $0 spend / 0-lead figures. COMPOSITE_IMPORT_METRIC_KEYS in
    // shared/importMetricPresence.ts now routes these rows through
    // importMetricNotFound (descendant evidence + deep non-zero value), so
    // evidence-less all-zero composites are hidden into "Not found in PDF"
    // and never applied; `selApplied` below refuses them at apply time too.
    // gbpLocations (name-bearing array rows) and totalLeads (reference-only,
    // force-unchecked) stay outside the gate. Pinned by
    // tests/client/report-initial-import-marketing-fabricated-zero.test.tsx.
    const marketingUpdates: any = {};
    if (sel["marketing.totalLeads"]) marketingUpdates.totalLeads = parsed.marketing?.totalLeads || 0;
    if (sel["marketing.gbpLocations"] && parsed.marketing?.gbpLocations?.length > 0) {
      const gbpCombined = { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
      for (const loc of parsed.marketing.gbpLocations) {
        gbpCombined.good += loc.leadQuality?.good || 0;
        gbpCombined.notQuotable += loc.leadQuality?.notQuotable || 0;
        gbpCombined.missedCalls += loc.leadQuality?.missedCalls || 0;
        gbpCombined.noData += loc.leadQuality?.noData || 0;
      }
      marketingUpdates.leadQuality = gbpCombined;
    }
    // Task #3868 — SUB-FIELD-grain evidence inside an APPLIED composite. A
    // partially-parsed composite (e.g. LSA uniqueLeads found via the quality
    // table, adSpend still a parser-defaulted 0) passes the #3858 row gate,
    // but applying it must not overwrite a real saved sub-value with a $0
    // the PDF never contained. An evidence-less zero sub-field preserves the
    // current form value; any evidenced or non-zero parsed sub-value applies
    // normally. Pinned by
    // tests/client/report-reimport-marketing-partial-composite.test.tsx.
    const applySub = (
      compositeKey: string,
      parsedValue: number | undefined,
      currentValue: number | undefined,
      evidenceSubFields: string[],
    ): number =>
      evidenceSubFields.every((sf) => importCompositeSubFieldNotFound(parsed, compositeKey, sf))
        ? (currentValue || 0)
        : (parsedValue || 0);
    if (selApplied("marketing.googleAds")) {
      marketingUpdates.googleAds = {
        uniqueLeads: applySub("marketing.googleAds", parsed.marketing?.googleAds?.uniqueLeads, marketingData.googleAds?.uniqueLeads, ["uniqueLeads"]),
        adSpend: applySub("marketing.googleAds", parsed.marketing?.googleAds?.adSpend, marketingData.googleAds?.adSpend, ["adSpend"]),
        leadQuality: parsed.marketing?.googleAds?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (selApplied("marketing.googleAds.leadQuality") && !selApplied("marketing.googleAds")) {
      marketingUpdates.googleAds = {
        ...marketingUpdates.googleAds,
        leadQuality: parsed.marketing?.googleAds?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (selApplied("marketing.lsa")) {
      marketingUpdates.lsa = {
        uniqueLeads: applySub("marketing.lsa", parsed.marketing?.lsa?.uniqueLeads, marketingData.lsa?.uniqueLeads, ["uniqueLeads"]),
        adSpend: applySub("marketing.lsa", parsed.marketing?.lsa?.adSpend, marketingData.lsa?.adSpend, ["adSpend"]),
        leadQuality: parsed.marketing?.lsa?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (selApplied("marketing.lsa.leadQuality") && !selApplied("marketing.lsa")) {
      marketingUpdates.lsa = {
        ...marketingUpdates.lsa,
        leadQuality: parsed.marketing?.lsa?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (sel["marketing.gbpLocations"]) {
      const rawLocations = (parsed.marketing?.gbpLocations || []).map((loc: any) => ({
        id: crypto.randomUUID(),
        name: loc.name || '',
        uniqueLeads: loc.uniqueLeads || 0,
        reviewsGenerated: loc.reviewsGenerated || 0,
        reviewsRespondedTo: loc.reviewsRespondedTo || 0,
        postsQaCount: loc.postsQaCount || 0,
        leadQuality: loc.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      }));
      const gbpMergeResult = mergeImportedGbpLocations(
        marketingData.gbpLocations || [],
        rawLocations,
        (clientLocations || []).map(cl => ({ id: cl.id, name: cl.name })),
      );
      marketingUpdates.gbpLocations = gbpMergeResult.merged;
      // Surface (do not silently add) any imported location that resolves to
      // neither an existing report row nor a Command Panel location. These are
      // likely from a foreign / wrong-source PDF — the operator decides whether
      // to add them to the client's Command Panel and re-import, or discard.
      unresolvedGbpImportNames = gbpMergeResult.unresolved
        .map(u => (u.name || '').trim())
        .filter(Boolean);
    }
    if (selApplied("marketing.webinar")) {
      marketingUpdates.webinar = {
        registrants: applySub("marketing.webinar", parsed.marketing?.webinar?.registrants, marketingData.webinar?.registrants, ["registrants"]),
        attendees: applySub("marketing.webinar", parsed.marketing?.webinar?.attendees, marketingData.webinar?.attendees, ["attendees"]),
        // hotTransfers may be sourced from webinar.leads — either sub-key is evidence.
        hotTransfers: applySub("marketing.webinar", parsed.marketing?.webinar?.hotTransfers || parsed.marketing?.webinar?.leads, marketingData.webinar?.hotTransfers, ["hotTransfers", "leads"]),
        leadQuality: parsed.marketing?.webinar?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (selApplied("marketing.reviewGeneration")) {
      marketingUpdates.reviewGeneration = parsed.marketing?.reviewGeneration || { listContacted: 0, listReviews: 0, webinarReviews: 0, otherCount: 0, totalReviews: 0 };
    }
    if (selApplied("marketing.otherLeads") && parsed.marketing?.otherLeads?.total > 0) {
      marketingUpdates.otherLeads = {
        count: parsed.marketing.otherLeads.total,
        description: [
          parsed.marketing.otherLeads.socialMedia > 0 ? `Social Media: ${parsed.marketing.otherLeads.socialMedia}` : "",
          parsed.marketing.otherLeads.directCalls > 0 ? `Direct Calls: ${parsed.marketing.otherLeads.directCalls}` : "",
          parsed.marketing.otherLeads.referrals > 0 ? `Referrals: ${parsed.marketing.otherLeads.referrals}` : "",
        ].filter(Boolean).join(", "),
        leadQuality: parsed.marketing.otherLeads.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      };
    }
    if (parsed.marketing?.blogPostUrl) {
      marketingUpdates.blogPostUrl = parsed.marketing.blogPostUrl;
    }

    if (Object.keys(marketingUpdates).length > 0) {
      setMarketingData(prev => ({ ...prev, ...marketingUpdates }));
    }

    if (sel["clientName"] && parsed.clientName && clients) {
      const matchedClient = clients.find((c: Client) => 
        c.firmName.toLowerCase().includes(parsed.clientName!.toLowerCase()) ||
        parsed.clientName!.toLowerCase().includes(c.firmName.toLowerCase())
      );
      if (matchedClient) {
        setFormData(prev => ({ ...prev, clientId: matchedClient.id }));
      }
    }

    if (sel["reportMonth"] && parsed.reportMonth) {
      setFormData(prev => ({ ...prev, reportMonth: parsed.reportMonth! }));
    }

    setShowImportReview(false);
    setPendingImportData(null);
    setWebinarConflictFlagged(false);
    setUnresolvedGbpImports(unresolvedGbpImportNames);
    if (unresolvedGbpImportNames.length > 0) {
      toast({
        title: 'PDF data applied — some locations need review',
        description: `${unresolvedGbpImportNames.length} imported GBP location(s) aren't in this client's command panel and were not added. See the warning above the GBP section.`,
        variant: 'destructive',
      });
    } else {
      toast({ title: 'PDF data applied', description: 'Review the pre-filled data before saving' });
    }
  }, [pendingImportData, importFieldSelections, clients, toast, clientLocations, marketingData.gbpLocations, marketingData.googleAds?.adSpend, marketingData.googleAds?.uniqueLeads, marketingData.lsa?.adSpend, marketingData.lsa?.uniqueLeads, marketingData.webinar?.attendees, marketingData.webinar?.hotTransfers, marketingData.webinar?.registrants]);

  const createReportMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.existingReportId) {
          return { id: data.existingReportId, alreadyExists: true };
        }
        throw new Error(data.error || "Failed to create report");
      }
      return data;
    },
    onSuccess: async (report) => {
      setActiveReportId(report.id);
      if (report.alreadyExists) {
        toast({ title: "A report for this month already exists. Opening it now." });
        navigate(`/reports/${report.id}`);
        return;
      }

      if (importedData) {
        const saveSection = async (sectionKey: string, data: any) => {
          const res = await fetch(`/api/reports/${report.id}/sections/${sectionKey}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            // Task #3769 — echo the parse's placeholder-section signal
            // (importMeta from /api/reports/import-pdf) so the server can
            // persist the broken-source warning on intake/sales saves.
            body: JSON.stringify({
              data,
              editSource: "manual_pdf_upload",
              ...(importedData?.importMeta ? { importMeta: importedData.importMeta } : {}),
            }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || `Failed to save ${sectionKey}`);
          }
          return res.json();
        };

        try {
          // Task #2680 — numerator and denominator come from the SAME lead set
          // (both include Other), with the per-client hideOtherLeads toggle
          // applied symmetrically, then clamped to a sane 0–100%.
          const mcAdjusted = applyHideOtherLeads({
            missedCalls: calculatedLeadQuality.missedCalls,
            totalLeads: calculatedTotalLeads,
            otherMissedCalls: marketingData.otherLeads?.leadQuality?.missedCalls || 0,
            otherLeadCount: marketingData.otherLeads?.count || 0,
            hideOtherLeads: selectedClient?.hideOtherLeads === true,
          });
          // Task #4983 — three-tier resolution (shared resolver): bucket
          // evidence → recompute; else a pushed/typed stored rate > 0
          // survives (an import with no missed-call data must not stamp a
          // fabricated 0 over it); else 0 — display-time resolution renders
          // a stored 0 as "No data", so the legacy 0 shape stays inert.
          const calculatedMissedCallRateVal = resolveMissedCallRate({
            bucketMissedCalls: mcAdjusted.missedCalls,
            totalLeads: mcAdjusted.totalLeads,
            storedRate: intakeData.missedCallRate,
          }) ?? 0;

          await Promise.all([
            saveSection("intake", {
              ...intakeData,
              missedCallRate: calculatedMissedCallRateVal,
              leadToConsultRate,
              noDataFlags: intakeData.noDataFlags,
            }),
            saveSection("sales", {
              totalConsults: intakeData.totalConsults,
              totalCases: salesData.totalCases,
              consultToCaseRate,
              averageCaseValue: salesData.averageCaseValue,
              noShowRate: salesData.noShowRate,
              avgFollowUps: salesData.avgFollowUps,
              qualityScore: salesData.qualityScore,
              commonIssues: salesData.commonIssues,
              dealTouchDensity: salesData.dealTouchDensity,
              avgAgeOpenMatters: salesData.avgAgeOpenMatters,
              pipelineMomentumScore: salesData.pipelineMomentumScore,
              noDataFlags: salesData.noDataFlags,
            }),
            saveSection("marketing", {
              totalLeads: calculatedTotalLeads,
              posture: marketingData.posture,
              leadQuality: calculatedLeadQuality,
              gbpLeadQuality: marketingData.leadQuality,
              googleAdsEnabled: marketingData.googleAdsEnabled,
              lsaEnabled: marketingData.lsaEnabled,
              gbp: { locations: marketingData.gbpLocations, shared: { blogPostUrl: marketingData.blogPostUrl || undefined } },
              googleAds: { ...marketingData.googleAds, costPerLead: googleAdsCostPerLead },
              lsa: { ...marketingData.lsa, costPerLead: lsaCostPerLead },
              webinar: { ...marketingData.webinar, showRate: webinarShowRate, hotTransferRate: webinarHotTransferRate },
              reviewGeneration: {
                list: { contacted: marketingData.reviewGeneration.listContacted, reviews: marketingData.reviewGeneration.listReviews, activationRate: listActivationRate },
                webinar: { reviews: marketingData.reviewGeneration.webinarReviews, activationRate: webinarActivationRate },
                other: { count: marketingData.reviewGeneration.otherCount },
                totalReviews: marketingData.reviewGeneration.totalReviews || 0,
                monthlyTarget: marketingData.reviewGeneration.monthlyTarget || 0,
              },
              otherLeads: { count: marketingData.otherLeads?.count || 0, description: marketingData.otherLeads?.description || "", leadQuality: marketingData.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 } },
            }),
          ]);

          if (salesData.averageCaseValue > 0) {
            updateClientCaseValueMutation.mutate(salesData.averageCaseValue);
          }
          logActivity("save", "Created report with imported data", { reportId: report.id, clientId: formData.clientId });
          toast({ title: "Report created and imported data saved" });
        } catch (err: any) {
          console.error("Failed to auto-save imported sections:", err);
          toast({ title: "Report created but some data may not have saved. Please re-save each section.", variant: "destructive" });
        }
      } else {
        logActivity("save", "Created report", { reportId: report.id, clientId: formData.clientId });
        toast({ title: "Report created" });
      }

      navigate(`/reports/${report.id}`);
    },
    onError: (error: Error) => {
      toast({ title: error.message || "Failed to create report", variant: "destructive" });
    },
  });

  const [showReviewGateDialog, setShowReviewGateDialog] = useState(false);
  const [reviewGateClientId, setReviewGateClientId] = useState<string | null>(null);

  const updateReportMutation = useMutation({
    mutationFn: async (vars: { confirmBrokenSource?: boolean; confirmQuality?: boolean } | void) => {
      if (!activeReportId) throw new Error("No report ID available");
      const res = await fetch(`/api/reports/${activeReportId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          status: formData.status,
          hideLeadQuality: formData.hideLeadQuality,
          // Task #4537 — "Presented / Delivered" mark; boolean only, the
          // server derives the actor + timestamp stamp (repeated true never
          // re-stamps, false clears).
          presented: formData.presented,
          // Task #3769 — explicit broken-source finalize confirmation,
          // validated server-side against the persisted warning state.
          ...(vars && vars.confirmBrokenSource ? { confirmBrokenSourceFinalize: true } : {}),
          // Task #4227 — explicit report-quality finalize confirmation
          // (degenerate Common Issues / empty Next 30 Days), validated
          // server-side against the persisted section content.
          ...(vars && vars.confirmQuality ? { confirmReportQualityFinalize: true } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error === "monthly_review_required") {
          throw { isReviewGate: true, clientId: data.clientId, message: data.message };
        }
        if (data.error === "broken_source_confirm_required") {
          throw { isBrokenSourceGate: true, missingMetrics: data.missingMetrics ?? [] };
        }
        if (data.error === "report_quality_confirm_required") {
          throw {
            isQualityGate: true,
            degenerateCommonIssues: data.degenerateCommonIssues ?? [],
            emptyNextActionsColumns: data.emptyNextActionsColumns ?? [],
          };
        }
        if (data.error === "verdict_quality_floor") {
          // Task #4273 — HARD gate (no confirm bypass): degenerate slide
          // verdicts can never reach a finalized report.
          throw { isVerdictGate: true, message: data.message };
        }
        throw new Error(data.error || "Failed to update report");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/reports", activeReportId] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      if (formData.clientId) {
        void queryClient.invalidateQueries({ queryKey: ["/api/clients", formData.clientId, "reports"] }); // fire-and-forget: cache refresh only
      }
      logActivity("save", "Updated report status", { reportId: activeReportId, status: formData.status });
      toast({ title: "Report updated" });
    },
    onError: (error: any) => {
      if (error?.isReviewGate) {
        setReviewGateClientId(error.clientId);
        setShowReviewGateDialog(true);
        setFormData(prev => ({ ...prev, status: existingReport?.status || "draft" }));
      } else if (error?.isQualityGate) {
        // Task #4227 — the SERVER-side report-quality gate fired
        // (degenerate Common Issues copy and/or empty Next 30 Days).
        // Surface the confirm dialog; "Finalize Anyway" re-submits with the
        // explicit confirmation flag.
        const gaps: string[] = [];
        const thinSections: CommonIssuesSection[] = [];
        for (const d of (error.degenerateCommonIssues as Array<{ section: string; problems: Array<{ snippet: string }> }>) ?? []) {
          const label = d.section === "intake" ? "Intake" : "Sales";
          const snippet = d.problems?.[0]?.snippet ?? "";
          gaps.push(`${label} Common Issues copy is too thin to publish${snippet ? ` (e.g. "${snippet}")` : ""}`);
          if (d.section === "intake" || d.section === "sales") {
            thinSections.push(d.section);
          }
        }
        const emptyCols = ((error.emptyNextActionsColumns as string[]) ?? [])
          .map((c) => (c === "ours" ? "Our Actions" : "Your Actions"));
        if (emptyCols.length > 0) {
          gaps.push(`Next 30 Days has no entries in ${emptyCols.join(" and ")} — the shared report will show "No actions defined"`);
        }
        setMissingFields([]);
        setQualityGateGaps(gaps);
        setQualityGateThinSections(thinSections);
        setCuratedSelections({});
        setPendingFinalize(true);
        setShowMissingFieldsDialog(true);
      } else if (error?.isBrokenSourceGate) {
        // Task #3769 — the SERVER-side broken-source gate fired without the
        // client-side check having caught it (stale local warning state).
        // Surface the same confirm dialog; "Finalize Anyway" re-submits with
        // the explicit confirmation flag.
        const labels = (error.missingMetrics as string[]).map((m) =>
          m === "totalConsults" ? `Total ${t("consults")}` : `Total ${t("cases")}`,
        );
        setMissingFields([]);
        setFunnelConfirmMetrics(labels);
        setPendingFinalize(true);
        setShowMissingFieldsDialog(true);
      } else if (error?.isVerdictGate) {
        // Task #4273 — hard server gate: jump to the Verdicts tab where the
        // inline floor hints mark exactly which fields to fix or clear.
        setFormData(prev => ({ ...prev, status: existingReport?.status || "draft" }));
        setActiveTab("verdicts");
        toast({
          title: "Slide verdicts below the publish floor",
          description: error.message || "Fix or clear the flagged verdicts, then finalize again.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed to update report", variant: "destructive" });
      }
    },
  });

  // Task #4254 — operator explicitly replaces a thin section's Common Issues
  // with the selected curated library blocks. Stored via the normal section
  // save path (saveSectionMutation → PUT /sections/:key) with a distinct
  // audit source; never auto-applied.
  function applyCuratedCopy(section: CommonIssuesSection) {
    const selected = getCuratedIssueBlocks(section).filter((b) => curatedSelections[b.id]);
    if (selected.length === 0) return;
    const formatted = renderCuratedIssueBlocks(selected);
    if (section === "intake") {
      setIntakeData(prev => {
        const next = { ...prev, commonIssues: formatted };
        if (activeReportId) {
          saveSectionMutation.mutate({ sectionKey: "intake", data: next, editSource: "curated_library" });
        }
        return next;
      });
    } else {
      setSalesData(prev => {
        const next = { ...prev, commonIssues: formatted };
        if (activeReportId) {
          saveSectionMutation.mutate({ sectionKey: "sales", data: next, editSource: "curated_library" });
        }
        return next;
      });
    }
    const label = section === "intake" ? "Intake" : "Sales";
    setQualityGateThinSections(prev => prev.filter(s => s !== section));
    setQualityGateGaps(prev => prev.filter(g => !g.startsWith(`${label} Common Issues`)));
    toast({
      title: `${label} Common Issues replaced`,
      description: `${selected.length} curated issue${selected.length > 1 ? "s" : ""} applied. Review and edit the copy on the ${label} tab if needed.`,
    });
  }

  function proceedWithFinalize() {
    flushAllAutosaves();
    // Task #3769 — when the dialog carried the broken-source callout,
    // "Finalize Anyway" IS the explicit confirmation; pass it through to the
    // server-side gate.
    // Task #4227 — likewise for the report-quality gate: "Finalize Anyway"
    // carries the explicit quality confirmation when the dialog named gaps.
    const confirms = {
      ...(funnelConfirmMetrics.length > 0 ? { confirmBrokenSource: true } : {}),
      ...(qualityGateGaps.length > 0 ? { confirmQuality: true } : {}),
    };
    updateReportMutation.mutate(
      Object.keys(confirms).length > 0 ? confirms : undefined,
    );
  }

  function saveCurrentTabAndStatus() {
    if (!activeReportId) {
      toast({ title: "Report not ready. Please wait and try again.", variant: "destructive" });
      return;
    }
    // Task #4801 — the confirm flow below is TRANSITION-ONLY: it runs when
    // this save would flip the report draft → final, mirroring the server
    // gates on PATCH /api/reports/:id (all fire only on `status === "final"
    // && report.status !== "final"`). Saving an already-final report (e.g.
    // adding a Next 30 Days action after the review call) saves directly —
    // re-prompting "Finalize Anyway?" here is what taught operators that
    // finalized reports can't be edited.
    const isFinalizeTransition =
      formData.status === "final" && existingReport?.status !== "final";
    if (isFinalizeTransition) {
      const missing = detectMissingFields();
      // Task #3769 — when a broken-source import flagged Consults/Cases as
      // missing-vs-prior and they are STILL not entered (and not deliberately
      // No-Data-flagged), finalizing requires an explicit confirm. Reuses the
      // missing-fields dialog ("Finalize Anyway" = the confirm) with a
      // prominent broken-source callout. Client-side only — the server
      // monthly-review gate is unchanged.
      const funnelStillMissing: string[] = [];
      if (brokenSourceWarning) {
        for (const m of brokenSourceWarning.missingMetrics) {
          if (m === "totalConsults" && !intakeData.noDataFlags?.totalConsults && intakeData.totalConsults === 0) {
            funnelStillMissing.push(`Total ${t("consults")}`);
          }
          if (m === "totalCases" && !salesData.noDataFlags?.totalCases && salesData.totalCases === 0) {
            funnelStillMissing.push(`Total ${t("cases")}`);
          }
        }
      }
      if (missing.length > 0 || funnelStillMissing.length > 0) {
        setMissingFields(missing);
        setFunnelConfirmMetrics(funnelStillMissing);
        setPendingFinalize(true);
        setShowMissingFieldsDialog(true);
        return;
      }
    }
    flushAllAutosaves();
    updateReportMutation.mutate();
  }

  // Update client data access (when user marks data as now available)
  const updateDataAccessMutation = useMutation({
    mutationFn: async ({ category, status }: { category: string; status: string }) => {
      if (!formData.clientId) throw new Error("No client selected");
      const res = await fetch(`/api/clients/${formData.clientId}/data-access/${category}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update data access");
      return { ...(await res.json()), category, status };
    },
    onSuccess: (data) => {
      // Task #2418 follow-up — authoritatively write the new status into the
      // cache before invalidating so the critical/detected alerts and status
      // pills update immediately instead of snapping back to the pre-save
      // value while the refetch settles ("reverts automatically").
      queryClient.setQueryData<DataAccessItem[]>(
        ["/api/clients", formData.clientId, "data-access"],
        (old) => {
          const list = old ? [...old] : [];
          const idx = list.findIndex((d) => d.category === data.category);
          if (idx >= 0) {
            list[idx] = { ...list[idx], status: data.status };
          } else {
            list.push({ category: data.category, status: data.status } as DataAccessItem);
          }
          return list;
        },
      );
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", formData.clientId, "data-access"] }); // fire-and-forget: cache refresh only
      toast({ title: "Client data access updated" });
      
      // If marking as available, clear the corresponding noDataFlags
      if (data.status === "available") {
        if (data.category === "consult_bookings") {
          setIntakeData(prev => ({
            ...prev,
            noDataFlags: {
              ...prev.noDataFlags,
              totalConsults: false,
              avgTimeToAnswer: false,
              qualityScore: false,
            }
          }));
        }
        if (data.category === "sales_conversions") {
          setSalesData(prev => ({
            ...prev,
            noDataFlags: {
              ...prev.noDataFlags,
              totalCases: false,
              averageCaseValue: false,
            }
          }));
        }
        if (data.category === "no_show_rate") {
          setSalesData(prev => ({
            ...prev,
            noDataFlags: { ...prev.noDataFlags, noShowRate: false }
          }));
        }
        if (data.category === "follow_up_touches") {
          setSalesData(prev => ({
            ...prev,
            noDataFlags: { ...prev.noDataFlags, pipelineMomentumScore: false }
          }));
        }
        if (data.category === "sales_transcripts") {
          setSalesData(prev => ({
            ...prev,
            noDataFlags: { ...prev.noDataFlags, qualityScore: false }
          }));
        }
      }
    },
    onError: () => {
      toast({ title: "Failed to update data access", variant: "destructive" });
    },
  });

  // Per-section autosave aggregation. Four debounced watchers save
  // concurrently through saveSectionMutation; a single scalar feedback
  // state would let the FIRST settlement claim "All changes saved" while
  // sibling sections are still in flight or failed. The aggregator keys
  // in-flight counts and failure flags by sectionKey; the component
  // subscribes via useSyncExternalStore below (the aggregator caches its
  // snapshot object, so getSnapshot is referentially stable between
  // changes — no version-tick state needed).
  const autosaveAggRef = useRef<AutosaveAggregator | null>(null);
  if (!autosaveAggRef.current) {
    autosaveAggRef.current = createAutosaveAggregator();
  }
  const autosaveAgg = autosaveAggRef.current;

  const saveSectionMutation = useMutation({
    mutationFn: async ({ sectionKey, data, isAutosave, editSource }: { sectionKey: string; data: any; isAutosave?: boolean; editSource?: "ui_edit" | "ai_format" | "manual_pdf_upload" | "curated_library" }) => {
      if (!activeReportId) {
        throw new Error("No report ID available - please wait for report to load");
      }
      if (isAutosave) {
        autosaveAgg.record(sectionKey, "start");
      }
      const url = `/api/reports/${activeReportId}/sections/${sectionKey}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ 
          data,
          expectedUpdatedAt: sectionTimestamps[sectionKey],
          editSource: editSource || "ui_edit",
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (errorData.code === "CONFLICT") {
          throw new Error("This section was modified by another user. Please refresh the page to see the latest changes.");
        }
        throw new Error(errorData.error || "Failed to save section");
      }
      return { section: await res.json(), sectionKey, isAutosave: !!isAutosave };
    },
    onSuccess: ({ section, sectionKey, isAutosave }) => {
      if (section.updatedAt) {
        setSectionTimestamps(prev => ({ ...prev, [sectionKey]: section.updatedAt }));
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/reports", activeReportId] }); // fire-and-forget: cache refresh only
      if (sectionKey === 'marketing' || sectionKey === 'sales') {
        void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      }
      if (isAutosave) {
        autosaveAgg.record(sectionKey, "success");
      } else {
        toast({ title: "Section saved" });
      }
      detectMissingFields();
    },
    onError: (error: Error, variables) => {
      console.error("[saveSectionMutation] Error:", error);
      if (variables.isAutosave) {
        autosaveAgg.record(variables.sectionKey, "failure");
      } else {
        toast({ title: error.message || "Failed to save section", variant: "destructive" });
      }
    },
  });

  // Task #4273 — slide-verdict authoring helpers (Verdicts tab). Saves are
  // dirty-checked autosaves through the normal section save path; applying
  // an AI draft saves with the existing "ai_format" audit source.
  const saveVerdictsMap = (next: SlideVerdictMap, editSource: "ui_edit" | "ai_format" = "ui_edit") => {
    const clean = sanitizeSlideVerdictMap(next);
    const json = JSON.stringify(clean);
    if (json === verdictsSavedJson) return;
    setVerdictsSavedJson(json);
    saveSectionMutation.mutate({ sectionKey: "slideVerdicts", data: { verdicts: clean }, isAutosave: true, editSource });
  };

  const clearVerdict = (key: SlideVerdictKey) => {
    const next = { ...verdictsDataRef.current };
    delete next[key];
    verdictsDataRef.current = next;
    setVerdictsData(next);
    saveVerdictsMap(next);
  };

  const draftVerdict = async (key: SlideVerdictKey) => {
    if (!activeReportId || draftingVerdictKey) return;
    setDraftingVerdictKey(key);
    try {
      const res = await fetch(`/api/reports/${activeReportId}/verdicts/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ slideKey: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.verdict !== "string") {
        throw new Error(data.message || "AI draft failed — try again or write it manually.");
      }
      // Merge against the LIVE map, not this function's start-time closure —
      // the operator may have edited other slides while the draft was in
      // flight, and saving a stale merge would silently revert those edits.
      const next = { ...verdictsDataRef.current, [key]: data.verdict };
      verdictsDataRef.current = next;
      setVerdictsData(next);
      saveVerdictsMap(next, "ai_format");
      toast({ title: `${SLIDE_VERDICT_LABELS[key]} verdict drafted` });
    } catch (err: any) {
      toast({ title: "Verdict draft failed", description: err?.message, variant: "destructive" });
    } finally {
      setDraftingVerdictKey(null);
    }
  };

  const updateClientCaseValueMutation = useMutation({
    mutationFn: async (averageCaseValue: number) => {
      const res = await fetch(`/api/clients/${formData.clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ averageCaseValue }),
      });
      if (!res.ok) throw new Error("Failed to update client");
      return res.json();
    },
  });

  const updateClientProductsMutation = useMutation({
    mutationFn: async (newProducts: string[]) => {
      const res = await fetch(`/api/clients/${formData.clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ products: newProducts }),
      });
      if (!res.ok) throw await parseClientSaveError(res, "Failed to update client products");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      toast({ title: "Client products updated", description: "The report will now show leads from the newly activated sources." });
      setInactiveLeadsDialogOpen(false);
      setInactiveLeadsDismissed(true);
    },
    onError: (err: Error) => {
      const e = err as ClientSaveError;
      toast({
        title: e.message || "Failed to update products",
        description: e.description,
        variant: "destructive",
      });
    },
  });

  // Adds a report row that is flagged "Not in command panel" to the client's
  // Command Panel locations. On success we re-link the report row to the new
  // persistent location id so the stale badge clears without a manual refresh.
  // This is an explicit operator action — nothing is auto-created on import.
  const addStaleLocationMutation = useMutation({
    mutationFn: async (data: { idx: number; name: string; address: string }) => {
      const res = await fetch(`/api/clients/${formData.clientId}/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: data.name, address: data.address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || err.message || "Failed to add location to the command panel.");
      }
      const created = await res.json();
      return { idx: data.idx, created };
    },
    onSuccess: ({ idx, created }) => {
      // Re-link the report row to the new persistent command-panel location id
      // so it resolves against clientLocations and the stale badge clears.
      if (created?.id) {
        setMarketingData(prev => {
          const updated = [...prev.gbpLocations];
          if (updated[idx]) {
            updated[idx] = { ...updated[idx], id: created.id, name: created.name || updated[idx].name };
          }
          return { ...prev, gbpLocations: updated };
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", formData.clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", formData.clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      setAddToCpIdx(null);
      setAddToCpAddress("");
      setAddToCpError("");
      toast({ title: "Location added to command panel" });
    },
    onError: (err: Error) => {
      setAddToCpError(err.message);
    },
  });

  const detectMissingFields = useCallback(() => {
    const missing: {section: string; fields: string[]}[] = [];

    const intakeFields: string[] = [];
    if (!intakeData.noDataFlags?.totalConsults && intakeData.totalConsults === 0) intakeFields.push(`Total ${t("consults")}`);
    if (!intakeData.noDataFlags?.avgTimeToAnswer && intakeData.avgTimeToAnswer === 0) intakeFields.push("Avg Time to Human Answer");
    if (!intakeData.noDataFlags?.qualityScore && intakeData.qualityScore === 0) intakeFields.push("Quality Score");
    if (intakeFields.length > 0) missing.push({ section: "Intake", fields: intakeFields });

    const salesFields: string[] = [];
    if (!salesData.noDataFlags?.totalCases && salesData.totalCases === 0) salesFields.push(`Total ${t("cases")}`);
    if (!salesData.noDataFlags?.averageCaseValue && salesData.averageCaseValue === 0) salesFields.push(t("averageCaseValue"));
    if (!salesData.noDataFlags?.qualityScore && salesData.qualityScore === 0) salesFields.push("Quality Score");
    if (salesFields.length > 0) missing.push({ section: "Sales", fields: salesFields });

    const marketingFields: string[] = [];
    if (!marketingData.posture) marketingFields.push("Marketing Posture");
    const gbpLeads = marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.uniqueLeads || 0), 0);
    const gadsLeads = marketingData.googleAds.uniqueLeads || 0;
    const lsaLeads = marketingData.lsa.uniqueLeads || 0;
    if (gbpLeads === 0 && gadsLeads === 0 && lsaLeads === 0) marketingFields.push(`${t("leads")} sources (no ${t("leads").toLowerCase()} from any source)`);
    if (marketingFields.length > 0) missing.push({ section: "Marketing", fields: marketingFields });

    const actionsFields: string[] = [];
    if (!nextActionsData.ours?.length && !nextActionsData.theirs?.length) actionsFields.push("Next 30 Days actions");
    if (actionsFields.length > 0) missing.push({ section: "Actions", fields: actionsFields });

    return missing;
  }, [intakeData, salesData, marketingData, nextActionsData, t]);

  function saveIntake(isAutosave?: boolean) {
    if (!activeReportId) {
      if (!isAutosave) toast({ title: "Report not ready. Please wait and try again.", variant: "destructive" });
      return;
    }
    // Task #2680 + #4983 — persist EXACTLY what the editor preview displays:
    // missedCallPreview is the ONE memoized resolution (hideOtherLeads applied
    // symmetrically, then the shared three-tier resolver), so preview, saved
    // value, and public card can never disagree. Tier 3 persists as 0 — the
    // form has no manual input for this field, and display-time resolution
    // renders a stored 0 as "No data", keeping the legacy 0 shape inert (a
    // save with empty buckets never stamps a fabricated 0 over a pushed rate;
    // tier 2 carries the stored rate through unchanged).
    const data = {
      ...intakeData,
      missedCallRate: missedCallPreview.rate ?? 0,
      leadToConsultRate,
      noDataFlags: intakeData.noDataFlags,
    };
    saveSectionMutation.mutate({ sectionKey: "intake", data, isAutosave });
  }

  function saveSales(isAutosave?: boolean) {
    if (!activeReportId) {
      if (!isAutosave) toast({ title: "Report not ready. Please wait and try again.", variant: "destructive" });
      return;
    }
    const data = {
      totalConsults: intakeData.totalConsults,
      totalCases: salesData.totalCases,
      consultToCaseRate,
      averageCaseValue: salesData.averageCaseValue,
      noShowRate: salesData.noShowRate,
      avgFollowUps: salesData.avgFollowUps,
      qualityScore: salesData.qualityScore,
      commonIssues: salesData.commonIssues,
      dealTouchDensity: salesData.dealTouchDensity,
      avgAgeOpenMatters: salesData.avgAgeOpenMatters,
      pipelineMomentumScore: salesData.pipelineMomentumScore,
      noDataFlags: salesData.noDataFlags,
    };
    saveSectionMutation.mutate({ sectionKey: "sales", data, isAutosave });
    if (salesData.averageCaseValue > 0) {
      updateClientCaseValueMutation.mutate(salesData.averageCaseValue);
    }
  }

  function saveMarketing(isAutosave?: boolean) {
    if (!activeReportId) {
      if (!isAutosave) toast({ title: "Report not ready. Please wait and try again.", variant: "destructive" });
      return;
    }
    const data = {
      totalLeads: calculatedTotalLeads,
      posture: marketingData.posture,
      leadQuality: calculatedLeadQuality,
      gbpLeadQuality: marketingData.leadQuality,
      googleAdsEnabled: marketingData.googleAdsEnabled,
      lsaEnabled: marketingData.lsaEnabled,
      gbp: {
        locations: marketingData.gbpLocations,
        shared: {
          blogPostUrl: marketingData.blogPostUrl || undefined,
        },
      },
      googleAds: {
        ...marketingData.googleAds,
        costPerLead: googleAdsCostPerLead,
      },
      lsa: {
        ...marketingData.lsa,
        costPerLead: lsaCostPerLead,
      },
      webinar: {
        ...marketingData.webinar,
        showRate: webinarShowRate,
        hotTransferRate: webinarHotTransferRate,
      },
      reviewGeneration: {
        list: { contacted: marketingData.reviewGeneration.listContacted, reviews: marketingData.reviewGeneration.listReviews, activationRate: listActivationRate },
        webinar: { reviews: marketingData.reviewGeneration.webinarReviews, activationRate: webinarActivationRate },
        other: { count: marketingData.reviewGeneration.otherCount },
        totalReviews: marketingData.reviewGeneration.totalReviews || 0,
        monthlyTarget: marketingData.reviewGeneration.monthlyTarget || 0,
      },
      otherLeads: {
        count: marketingData.otherLeads?.count || 0,
        description: marketingData.otherLeads?.description || "",
        leadQuality: marketingData.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 },
      },
    };
    saveSectionMutation.mutate({ sectionKey: "marketing", data, isAutosave });
  }

  function saveNextActions(isAutosave?: boolean) {
    if (!activeReportId) {
      if (!isAutosave) toast({ title: "Report not ready. Please wait and try again.", variant: "destructive" });
      return;
    }
    saveSectionMutation.mutate({ sectionKey: "nextActions", data: nextActionsData, isAutosave });
  }

  const autosaveEnabled = !!activeReportId && !!dataLoadedForReportId;

  const intakePayloadData = useMemo(() => JSON.stringify(intakeData), [intakeData]);
  const salesPayloadData = useMemo(() => JSON.stringify(salesData), [salesData]);
  const marketingPayloadData = useMemo(() => JSON.stringify(marketingData), [marketingData]);
  const nextActionsPayloadData = useMemo(() => JSON.stringify(nextActionsData), [nextActionsData]);

  const intakeAutosave = useAutosave({
    data: intakePayloadData,
    onSave: () => saveIntake(true),
    enabled: autosaveEnabled,
  });

  const salesAutosave = useAutosave({
    data: salesPayloadData,
    onSave: () => saveSales(true),
    enabled: autosaveEnabled,
  });

  const marketingAutosave = useAutosave({
    data: marketingPayloadData,
    onSave: () => saveMarketing(true),
    enabled: autosaveEnabled,
  });

  const nextActionsAutosave = useAutosave({
    data: nextActionsPayloadData,
    onSave: () => saveNextActions(true),
    enabled: autosaveEnabled,
  });

  // flush/markCurrentAsBaseline are stable useCallbacks inside useAutosave;
  // destructuring them satisfies exhaustive-deps without depending on the
  // per-render hook result objects (which would churn these deps every render).
  const { flush: flushIntakeAutosave, markCurrentAsBaseline: baselineIntakeAutosave } = intakeAutosave;
  const { flush: flushSalesAutosave, markCurrentAsBaseline: baselineSalesAutosave } = salesAutosave;
  const { flush: flushMarketingAutosave, markCurrentAsBaseline: baselineMarketingAutosave } = marketingAutosave;
  const { flush: flushNextActionsAutosave, markCurrentAsBaseline: baselineNextActionsAutosave } = nextActionsAutosave;

  const flushAllAutosaves = useCallback(() => {
    flushIntakeAutosave();
    flushSalesAutosave();
    flushMarketingAutosave();
    flushNextActionsAutosave();
  }, [flushIntakeAutosave, flushSalesAutosave, flushMarketingAutosave, flushNextActionsAutosave]);

  useEffect(() => {
    window.addEventListener("beforeunload", flushAllAutosaves);
    return () => window.removeEventListener("beforeunload", flushAllAutosaves);
  }, [flushAllAutosaves]);

  useEffect(() => {
    return () => {
      flushAllAutosaves();
    };
  }, [flushAllAutosaves]);

  const prevReportIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeReportId && activeReportId !== prevReportIdRef.current) {
      prevReportIdRef.current = activeReportId;
      baselineIntakeAutosave();
      baselineSalesAutosave();
      baselineMarketingAutosave();
      baselineNextActionsAutosave();
      // A different report's in-flight/failed history must not color the
      // fresh report's indicator.
      autosaveAgg.reset();
    }
  }, [activeReportId, baselineIntakeAutosave, baselineSalesAutosave, baselineMarketingAutosave, baselineNextActionsAutosave, autosaveAgg]);

  // Task #4282 — owner/due are optional; stored sparsely (key absent when
  // blank) so pre-#4282 rows and new rows share one shape.
  function buildActionItem(draft: { action: string; why: string; owner: string; due: string }): ActionItem {
    const item: ActionItem = { action: draft.action.trim(), why: draft.why.trim() };
    const owner = draft.owner.trim();
    if (owner) item.owner = owner;
    const due = draft.due.trim();
    if (due) item.due = due;
    return item;
  }

  function addOurAction() {
    if (newOurAction.action.trim()) {
      setNextActionsData(prev => ({
        ...prev,
        ours: [...prev.ours, buildActionItem(newOurAction)],
      }));
      setNewOurAction({ action: "", why: "", owner: "", due: "" });
    }
  }

  function addTheirAction() {
    if (newTheirAction.action.trim()) {
      setNextActionsData(prev => ({
        ...prev,
        theirs: [...prev.theirs, buildActionItem(newTheirAction)],
      }));
      setNewTheirAction({ action: "", why: "", owner: "", due: "" });
    }
  }

  function copyShareLink(isPrivate = false) {
    if (existingReport?.shareToken) {
      const url = `${window.location.origin}/share/${existingReport.shareToken}${isPrivate ? '?private=true' : ''}`;
      navigator.clipboard.writeText(url).catch((err) => console.error("[ReportForm] Clipboard write failed:", err)); // fire-and-forget: clipboard write
      toast({ title: isPrivate ? "Private share link copied" : "Share link copied" });
    }
  }

  // Autosave indicator state (Task #4351): distinguish typed-but-unsaved
  // ("dirty" — a debounced autosave is scheduled) from an in-flight save.
  // Dirty wins over everything else: while the author keeps typing — even
  // mid-save or after an error — the truthful state is "there are unsaved
  // changes" (the pending debounce fires another save).
  // NOTE: this block sits ABOVE the authLoading/!user early returns because
  // the useMemo is a hook — on a direct-URL load the skeleton renders first,
  // and the hook count must not grow when auth resolves (rules-of-hooks).
  const autosaveDirty =
    intakeAutosave.pending || salesAutosave.pending || marketingAutosave.pending || nextActionsAutosave.pending;
  const autosaveSnapshot = useSyncExternalStore(
    autosaveAgg.subscribe,
    autosaveAgg.snapshot,
  );
  const autosaveState = deriveAutosaveIndicator(autosaveSnapshot, autosaveDirty);

  if (authLoading) {
    return <FormSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <div className="text-muted-foreground">Please sign in to continue.</div>
      </div>
    );
  }

  const backClientId = existingReport?.clientId || formData.clientId || preselectedClientId;
  const backHref = backClientId ? `/clients/${backClientId}?tab=reports` : "/";

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1">
      {/* Task #4710 — standard page-header grammar (PageHeader, Task #4344)
          replacing the legacy bg-primary band. Sticky below the 56px global
          nav (PageHeader sticky variant) so the autosave state stays visible
          while scrolled deep in the long form. */}
      <PageHeader
        sticky
        className="px-3 sm:px-4 py-2 sm:py-3"
        title={isEditing ? "Edit Report" : "New Report"}
        backHref={backHref}
        backTestId="link-back"
        actions={
          isEditing ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {autosaveState !== "idle" && (
                <span
                  aria-live="polite"
                  className={`inline-flex items-center gap-1.5 text-xs font-normal ${
                    autosaveState === "error" ? "text-status-critical" :
                    autosaveState === "dirty" ? "text-status-warn" :
                    autosaveState === "saving" ? "text-muted-foreground" :
                    "text-status-ok"
                  }`}
                  data-testid="text-autosave-status"
                >
                  {autosaveState === "dirty" && (
                    <>
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                      Unsaved changes
                    </>
                  )}
                  {autosaveState === "saving" && (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Saving{"\u2026"}
                    </>
                  )}
                  {autosaveState === "saved" && (
                    <>
                      <Check className="w-3 h-3" />
                      All changes saved
                    </>
                  )}
                  {autosaveState === "error" && (
                    <>
                      <AlertCircle className="w-3 h-3" />
                      Save failed {"\u2014"} changes not saved
                    </>
                  )}
                </span>
              )}
              {existingReport && (
                <div className="flex items-center gap-2">
                  {existingReport.shareToken && existingReport.status === "final" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyShareLink(false)}
                        className="text-xs sm:text-sm"
                        data-testid="button-copy-share"
                      >
                        <Copy className="w-4 h-4 sm:mr-2" />
                        <span className="hidden sm:inline">Copy Link</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => copyShareLink(true)}
                        className="text-xs sm:text-sm"
                        title="Hides client name on shared report"
                        aria-label="Copy private link"
                        data-testid="button-copy-private-share"
                      >
                        <EyeOff className="w-4 h-4 sm:mr-2" />
                        <span className="hidden sm:inline">Copy Private Link</span>
                      </Button>
                    </>
                  )}
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="text-xs sm:text-sm"
                    data-testid="button-preview-report"
                  >
                    <a href={existingReport.status === "final" ? `/share/${existingReport.shareToken}` : `/preview/${existingReport.id}`} target="_blank" rel="noopener noreferrer" aria-label="Preview report">
                      <Eye className="w-4 h-4 sm:mr-2" />
                      <span className="hidden sm:inline">Preview</span>
                    </a>
                  </Button>
                </div>
              )}
            </div>
          ) : undefined
        }
      />

      <main className="max-w-7xl mx-auto p-3 sm:p-6">
        {!isEditing ? (
          <Card className="bg-card border-primary/10 max-w-xl">
            <CardHeader>
              <CardTitle className="text-foreground">Create New Report</CardTitle>
              <CardDescription>Select a client and month to begin</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => { e.preventDefault(); createReportMutation.mutate(); }} className="space-y-4">
                <div>
                  <Label htmlFor="clientId">Client *</Label>
                  <Popover open={clientPopoverOpen} onOpenChange={setClientPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        id="clientId"
                        variant="outline"
                        role="combobox"
                        aria-expanded={clientPopoverOpen}
                        className="w-full justify-between font-normal"
                        data-testid="select-client"
                      >
                        {formData.clientId
                          ? clients?.find(c => c.id === formData.clientId)?.firmName ?? "Select a client"
                          : "Select a client"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search clients..." />
                        <CommandList>
                          <CommandEmpty>No client found.</CommandEmpty>
                          <CommandGroup>
                            {clients?.map(c => (
                              <CommandItem
                                key={c.id}
                                value={c.firmName}
                                onSelect={() => {
                                  setFormData(prev => ({ ...prev, clientId: c.id }));
                                  setClientPopoverOpen(false);
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${formData.clientId === c.id ? "opacity-100" : "opacity-0"}`} />
                                {c.firmName}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div>
                  <Label htmlFor="reportMonth">Data Month *</Label>
                  <Input
                    id="reportMonth"
                    type="month"
                    value={formData.reportMonth}
                    onChange={e => setFormData(prev => ({ ...prev, reportMonth: e.target.value }))}
                    required
                    data-testid="input-report-month"
                  />
                  <p className="text-xs text-muted-foreground/70 mt-1">The month you're reporting on (e.g., December data)</p>
                </div>
                {/* PDF Import Section */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or import from PDF</span>
                  </div>
                </div>
                
                <div className="flex items-center justify-center">
                  <label className="flex items-center gap-2 px-4 py-2 border border-dashed border-border rounded-lg cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors">
                    <Upload className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">
                      {isImporting ? 'Importing...' : 'Upload PDF Report'}
                    </span>
                    <input
                      type="file"
                      accept=".pdf"
                      className="hidden"
                      disabled={isImporting}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handlePdfImport(file); // fire-and-forget: errors handled inside
                        e.target.value = '';
                      }}
                      data-testid="input-pdf-import"
                    />
                  </label>
                </div>
                
                {importedData && (
                  <Alert className="bg-status-ok/10 border-status-ok/40">
                    <AlertTitle className="text-status-ok">PDF Data Imported</AlertTitle>
                    <AlertDescription className="text-status-ok">
                      Data has been pre-filled from the PDF. Select a client and month above, then click "Start Building Report" to continue editing.
                    </AlertDescription>
                  </Alert>
                )}
                
                <Button 
                  type="submit" 
                  className="w-full bg-primary hover:bg-primary/90"
                  disabled={!formData.clientId || !formData.reportMonth || createReportMutation.isPending}
                  data-testid="button-create-report"
                >
                  Start Building Report
                </Button>
                {(!formData.clientId || !formData.reportMonth) && (
                  <p className="text-xs text-muted-foreground text-center" data-testid="text-create-report-hint">
                    Choose a client and data month to continue.
                  </p>
                )}
              </form>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card className="bg-card border-primary/10">
              {/* flex-wrap at both levels: the actions cluster (checkbox · toggle ·
                  status · Save · reimport) is ~990px wide and must reflow under the
                  title on phones instead of forcing horizontal page scroll. */}
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-y-3">
                <div className="min-w-0">
                  <CardTitle className="text-foreground break-words">{selectedClient?.firmName}</CardTitle>
                  <CardDescription>
                    Report for {formData.reportMonth && (() => {
                      const [year, month] = formData.reportMonth.split('-').map(Number);
                      return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
                    })()}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {/* Task #4537 — operator "Presented / Delivered" mark with
                      who/when caption; persisted via the Save button like the
                      Draft/Final status (not autosaved). */}
                  <div className="flex items-center gap-2 mr-2">
                    <Checkbox
                      id="presentedDelivered"
                      checked={formData.presented}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, presented: checked === true }))}
                      data-testid="checkbox-presented-delivered"
                    />
                    <div className="flex flex-col">
                      <Label htmlFor="presentedDelivered" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                        Presented / Delivered
                      </Label>
                      {existingReport?.presentedAt && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap" data-testid="text-presented-caption">
                          {(() => {
                            const u = existingReport.presentedByUser;
                            const name = u
                              ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "unknown"
                              : "unknown";
                            return `by ${name} · ${new Date(existingReport.presentedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
                          })()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mr-2">
                    <Switch
                      id="hideLeadQuality"
                      checked={formData.hideLeadQuality}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hideLeadQuality: checked }))}
                      data-testid="switch-hide-lead-quality"
                    />
                    <Label htmlFor="hideLeadQuality" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                      Hide {t("leads")} Quality
                    </Label>
                  </div>
                  <Select 
                    value={formData.status} 
                    onValueChange={v => {
                      setFormData(prev => ({ ...prev, status: v }));
                    }}
                  >
                    <SelectTrigger className="w-32" data-testid="select-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="final">Final</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button 
                    onClick={saveCurrentTabAndStatus}
                    className="bg-primary hover:bg-primary/90"
                    disabled={updateReportMutation.isPending || saveSectionMutation.isPending || !activeReportId}
                    data-testid="button-save-status"
                  >
                    <Save className="w-4 h-4 mr-2" />
                    Save
                  </Button>
                  {activeReportId && (
                    <div className="flex items-center gap-1 ml-2 border-l pl-2 border-border">
                      {existingReport?.hasStoredPdfUrl && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReimport()}
                          disabled={isReimporting}
                          data-testid="button-reimport-from-source"
                          title="Re-fetch and re-parse the PDF from the original webhook source URL"
                        >
                          {isReimporting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                          Re-parse from Source
                        </Button>
                      )}
                      <label className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-muted/50 transition-colors" data-testid="label-reimport-upload">
                        <Upload className="w-4 h-4" />
                        {isReimporting ? 'Reimporting...' : 'Reimport PDF'}
                        <input
                          type="file"
                          accept=".pdf"
                          className="hidden"
                          disabled={isReimporting}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void handleReimport(file); // fire-and-forget: errors handled inside
                            e.target.value = '';
                          }}
                          data-testid="input-reimport-pdf"
                        />
                      </label>
                    </div>
                  )}
                </div>
                {/* Task #4801 — a finalized report is LIVE, not locked: the
                    share link serves current data and saves skip every
                    finalize confirm (server gates are transition-only). Say
                    so right where operators hesitate — next to status/Save. */}
                {existingReport?.status === "final" && (
                  <div
                    className="flex basis-full items-start gap-2 border border-status-ok/40 bg-status-ok/10 px-3 py-2 text-xs text-foreground"
                    data-testid="notice-live-report"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-ok" />
                    <span>
                      This report is final
                      {existingReport?.shareToken ? " and live on its share link" : ""} — you can
                      still edit it. Saved changes (like Next 30 Days actions) publish immediately;
                      no re-finalize needed.
                    </span>
                  </div>
                )}
              </CardHeader>
            </Card>

            {/* Task #2418 — "Looks like you already have this" confirm prompt.
                Softer, distinct treatment for categories the flag marks
                not-available but where the system detects data is flowing. */}
            {detectedDataCategories.length > 0 && (
              <Alert className="bg-status-warn/10 border-status-warn/40" data-testid="alert-data-detected">
                <Sparkles className="h-5 w-5 text-status-warn" />
                <AlertTitle className="text-foreground font-bold">Looks like you already have this data</AlertTitle>
                <AlertDescription className="text-foreground">
                  <p className="mb-2">We're seeing data flowing in for these categories even though they aren't marked Available. If that's right, mark them Available:</p>
                  <div className="space-y-2">
                    {detectedDataCategories.map(cat => (
                      <div key={cat.id} className="flex items-center justify-between bg-status-warn/15 px-3 py-2 rounded">
                        <div>
                          <span className="font-semibold">{cat.label}</span>
                          <span className="ml-2 px-2 py-0.5 rounded text-xs uppercase bg-status-warn/15 text-status-warn">
                            Data detected
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => updateDataAccessMutation.mutate({ category: cat.id, status: "available" })}
                          disabled={updateDataAccessMutation.isPending}
                          className="text-xs px-3 py-1 bg-status-ok text-white rounded hover:bg-status-ok/90 disabled:opacity-50"
                          data-testid={`btn-mark-available-${cat.id}`}
                        >
                          Mark Available
                        </button>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Critical Missing Data Warning */}
            {criticalMissingCategories.length > 0 && (
              <Alert variant="destructive" className="bg-status-critical/10 border-status-critical/40">
                <AlertTriangle className="h-5 w-5" />
                <AlertTitle className="text-status-critical font-bold">Critical Missing Data</AlertTitle>
                <AlertDescription className="text-status-critical">
                  <p className="mb-2">The following data access is not available for this client. Discuss on every call:</p>
                  <div className="space-y-2">
                    {criticalMissingCategories.map(cat => (
                      <div key={cat.id} className="flex items-center justify-between bg-status-critical/15/50 px-3 py-2 rounded">
                        <div>
                          <span className="font-semibold">{cat.label}</span>
                          <span className="ml-2 px-2 py-0.5 rounded text-xs uppercase bg-status-critical/15 text-status-critical">
                            {cat.status === "refused" ? "CLIENT REFUSED" : cat.status === "pending" ? "PENDING ACCESS" : "UNKNOWN"}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => updateDataAccessMutation.mutate({ category: cat.id, status: "available" })}
                          disabled={updateDataAccessMutation.isPending}
                          className="text-xs px-3 py-1 bg-status-ok text-white rounded hover:bg-status-ok/90 disabled:opacity-50"
                          data-testid={`btn-mark-available-${cat.id}`}
                        >
                          Mark Available
                        </button>
                      </div>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Products Info */}
            {selectedClient && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="font-medium">Active Products:</span>
                {clientProducts.map(p => (
                  <span key={p} className="px-2 py-1 bg-card rounded border text-foreground font-medium capitalize">
                    {getProductLabel(p)}
                  </span>
                ))}
              </div>
            )}

            {/* Task #3769 — broken-source import warning. Sits ABOVE the tabs
                so it is visible whichever tab the operator lands on (the
                affected metrics live on the Intake and Sales tabs). */}
            {brokenSourceWarning &&
              (brokenSourceWarning.missingMetrics.length > 0 ||
                brokenSourceWarning.placeholderSections.length > 0) && (
              <Alert className="border-status-critical/40 bg-status-critical/10" data-testid="banner-broken-source-import">
                <AlertTriangle className="h-4 w-4 text-status-critical" />
                <AlertDescription>
                  <div className="text-sm text-foreground">
                    <span className="font-semibold">
                      This PDF import looks like it came from a report with a broken data source.
                    </span>{" "}
                    {brokenSourceWarning.missingMetrics.length > 0 && (
                      <>
                        <span className="font-medium">
                          {brokenSourceWarning.missingMetrics
                            .map((m) => (m === "totalConsults" ? `Total ${t("consults")}` : `Total ${t("cases")}`))
                            .join(" and ")}
                        </span>{" "}
                        came in empty even though the previous report
                        {brokenSourceWarning.priorReportMonth ? ` (${brokenSourceWarning.priorReportMonth})` : ""} had{" "}
                        {brokenSourceWarning.missingMetrics.length > 1 ? "them" : "it"} entered.{" "}
                      </>
                    )}
                    {brokenSourceWarning.placeholderSections.length > 0 && (
                      <>
                        The {brokenSourceWarning.placeholderSections.join(" and ")} Common Issues text was the
                        {" "}&ldquo;Missing data source&rdquo; placeholder and was not imported.{" "}
                      </>
                    )}
                    The report will show &ldquo;No data&rdquo; for missing metrics until entered — enter the real
                    values below or re-import a corrected PDF before finalizing.
                  </div>
                </AlertDescription>
              </Alert>
            )}

            <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
              <TabsList className="bg-card w-full flex-wrap h-auto gap-1 sm:flex-nowrap sm:h-10">
                <TabsTrigger value="marketing" className="flex-1 sm:flex-none text-xs sm:text-sm" data-testid="tab-marketing">Marketing</TabsTrigger>
                <TabsTrigger value="intake" className="flex-1 sm:flex-none text-xs sm:text-sm" data-testid="tab-intake">Intake</TabsTrigger>
                <TabsTrigger value="sales" className="flex-1 sm:flex-none text-xs sm:text-sm" data-testid="tab-sales">Sales</TabsTrigger>
                <TabsTrigger value="actions" className="flex-1 sm:flex-none text-xs sm:text-sm" data-testid="tab-actions">Actions</TabsTrigger>
                <TabsTrigger value="verdicts" className="flex-1 sm:flex-none text-xs sm:text-sm" data-testid="tab-verdicts">Verdicts</TabsTrigger>
              </TabsList>

              {/* INTAKE TAB */}
              <TabsContent value="intake">
                <Card className="bg-card border-primary/10">
                  <CardHeader>
                    <CardTitle className="text-foreground">Intake Data</CardTitle>
                    <CardDescription>How well are you capturing and qualifying opportunities?</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <SectionAuditInfo reportId={activeReportId} sectionKey="intake" {...getSectionMeta("intake")} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Total {t("consults")}</Label>
                          <button
                            type="button"
                            onClick={() => setIntakeData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, totalConsults: !prev.noDataFlags.totalConsults }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              intakeData.noDataFlags.totalConsults 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {intakeData.noDataFlags.totalConsults ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {intakeData.noDataFlags.totalConsults ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <Input
                            type="number"
                            min="0"
                            value={intakeData.totalConsults}
                            onChange={e => setIntakeData(prev => ({ ...prev, totalConsults: safeNumber(e.target.value, { allowDecimal: false }) }))}
                            data-testid="input-total-consults"
                          />
                        )}
                      </div>
                      <div>
                        <Label>{t("missedCallRate")} (%)</Label>
                        {/* Task #4983 — the preview IS the save resolution:
                            missedCallPreview (hideOtherLeads-symmetric lead
                            set → shared three-tier resolver) feeds this box
                            AND saveIntake, and the caption branches on the
                            resolver's own source verdict — a fabricated 0%
                            is never previewed, and the preview never shows a
                            bucket rate the save would resolve differently. */}
                        <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center">
                          {missedCallPreview.source === "buckets" ? (
                            <>
                              {missedCallPreview.rate}%
                              <span className="text-xs text-muted-foreground ml-2 font-normal">(from {t("leads")} Performance)</span>
                            </>
                          ) : missedCallPreview.source === "stored" ? (
                            <>
                              {missedCallPreview.rate}%
                              <span className="text-xs text-muted-foreground ml-2 font-normal">(pushed from client report)</span>
                            </>
                          ) : (
                            <>
                              No data
                              <span className="text-xs text-muted-foreground ml-2 font-normal">(no missed-call data this month)</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Avg Time to Human Answer (sec)</Label>
                          <button
                            type="button"
                            onClick={() => setIntakeData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, avgTimeToAnswer: !prev.noDataFlags.avgTimeToAnswer }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              intakeData.noDataFlags.avgTimeToAnswer 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {intakeData.noDataFlags.avgTimeToAnswer ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {intakeData.noDataFlags.avgTimeToAnswer ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <DecimalInput
                            value={intakeData.avgTimeToAnswer}
                            onCommit={n => setIntakeData(prev => ({ ...prev, avgTimeToAnswer: n }))}
                            placeholder="Target: <10s"
                            data-testid="input-avg-time-to-answer"
                          />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Intake Raw Quality Score</Label>
                          <button
                            type="button"
                            onClick={() => setIntakeData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, qualityScore: !prev.noDataFlags.qualityScore }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              intakeData.noDataFlags.qualityScore 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {intakeData.noDataFlags.qualityScore ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {intakeData.noDataFlags.qualityScore ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <>
                            <Input
                              type="number"
                              min="0"
                              max="100"
                              value={intakeData.qualityScore}
                              onChange={e => setIntakeData(prev => ({ ...prev, qualityScore: safeNumber(e.target.value, { max: 100 }) }))}
                              step="0.01"
                              placeholder="Raw score (e.g., 50)"
                            />
                          </>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div>
                        <Label>{t("leads")}-to-{t("consults")} Rate</Label>
                        <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center">
                          {leadToConsultRate}%
                          <span className="text-xs text-muted-foreground ml-2">(from Marketing {t("leads").toLowerCase()})</span>
                        </div>
                      </div>
                      <div>
                        <Label>Intake Execution Score</Label>
                        <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center text-sm" data-testid="text-intake-execution-score">
                          {intakeData.qualityScore > 0 ? (() => {
                            const targetRate = (selectedClient?.consultType === 'paid') ? 45 : 65;
                            const R = (leadToConsultRate / 100) / (targetRate / 100);
                            const ris = intakeData.qualityScore;
                            const ies = R < 1 ? Math.round(ris * R) : Math.min(100, Math.round(ris * (1 + (R - 1) * 0.5)));
                            return <>{ies} <span className="text-xs font-normal text-muted-foreground ml-2">(target {targetRate}% L→C)</span></>;
                          })() : <span className="text-xs font-normal text-muted-foreground/70">Enter Raw Quality Score above</span>}
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-4 space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Common Issues</Label>
                          <div className="flex items-center gap-1">
                            {intakeData.commonIssues.trim() && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditingIssues(prev => ({ ...prev, intake: !prev.intake }))}
                                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                                  data-testid="button-toggle-edit-intake-issues"
                                >
                                  <Pencil className="w-3 h-3" />
                                  {editingIssues.intake ? "Preview" : "Edit"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => formatCommonIssues(intakeData.commonIssues, "intake")}
                                  disabled={formattingIssues === "intake"}
                                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary-ink hover:bg-primary/15 transition-colors disabled:opacity-50"
                                  data-testid="button-ai-format-intake"
                                >
                                  {formattingIssues === "intake" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                                  AI Format
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {editingIssues.intake || !intakeData.commonIssues.trim() ? (
                          <textarea
                            className="w-full min-h-[80px] p-3 border rounded-md text-sm"
                            value={intakeData.commonIssues}
                            onChange={e => setIntakeData(prev => ({ ...prev, commonIssues: e.target.value }))}
                            placeholder="e.g., Lead follow-up taking too long, Unclear next steps for prospects"
                            data-testid="textarea-intake-common-issues"
                          />
                        ) : (
                          <div
                            className="w-full min-h-[80px] p-3 border rounded-md text-sm prose prose-sm max-w-none cursor-pointer hover:bg-muted/30 transition-colors [&_blockquote]:border-l-3 [&_blockquote]:border-primary/30 [&_blockquote]:bg-primary/5 [&_blockquote]:pl-3 [&_blockquote]:py-1.5 [&_blockquote]:my-1 [&_blockquote]:rounded-r-md [&_blockquote]:not-italic [&_hr]:my-3 [&_hr]:border-border [&_p]:my-1"
                            onClick={() => setEditingIssues(prev => ({ ...prev, intake: true }))}
                            data-testid="display-intake-common-issues"
                          >
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                              p: ({ children, ...props }) => {
                                const childArray = Array.isArray(children) ? children : [children];
                                const firstChild = childArray[0];
                                const trimmed = typeof firstChild === 'string' ? firstChild.trimStart() : '';
                                const isImpactLine = trimmed.startsWith('↳') || trimmed.startsWith('Impact:');
                                if (isImpactLine) {
                                  return <p className="!text-xs !text-foreground/60 !pl-5 !my-0.5 !leading-relaxed" {...props}>{children}</p>;
                                }
                                return <p {...props}>{children}</p>;
                              }
                            }}>{intakeData.commonIssues}</ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>

                  </CardContent>
                </Card>
              </TabsContent>

              {/* SALES TAB */}
              <TabsContent value="sales">
                <Card className="bg-card border-primary/10">
                  <CardHeader>
                    <CardTitle className="text-foreground">Sales Data</CardTitle>
                    <CardDescription>How effectively are you converting qualified leads into signed clients?</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <SectionAuditInfo reportId={activeReportId} sectionKey="sales" {...getSectionMeta("sales")} />
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Total {t("cases")}</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, totalCases: !prev.noDataFlags.totalCases }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.totalCases 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.totalCases ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.totalCases ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <Input
                            type="number"
                            value={salesData.totalCases}
                            onChange={e => setSalesData(prev => ({ ...prev, totalCases: safeNumber(e.target.value, { allowDecimal: false }) }))}
                            data-testid="input-total-cases"
                          />
                        )}
                      </div>
                      <div>
                        <Label>Consult-to-Case Rate</Label>
                        <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center">
                          {consultToCaseRate}%
                          <span className="text-xs text-muted-foreground ml-2">(auto)</span>
                        </div>
                      </div>
                      <div>
                        <Label>Sales Execution Score</Label>
                        <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center text-sm" data-testid="text-sales-execution-score">
                          {salesData.qualityScore > 0 ? (() => {
                            const targetRate = (selectedClient?.consultType === 'paid') ? 40 : 30;
                            const R = (consultToCaseRate / 100) / (targetRate / 100);
                            const sq = salesData.qualityScore;
                            const esq = R < 1 ? Math.round(sq * R) : Math.min(100, Math.round(sq * (1 + (R - 1) * 0.5)));
                            return <>{esq} <span className="text-xs font-normal text-muted-foreground ml-2">(target {targetRate}% C→C)</span></>;
                          })() : <span className="text-xs font-normal text-muted-foreground/70">Enter Raw Quality Score below</span>}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>{t("averageCaseValue")} ($)</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, averageCaseValue: !prev.noDataFlags.averageCaseValue }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.averageCaseValue 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.averageCaseValue ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.averageCaseValue ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <Input
                            type="number"
                            value={salesData.averageCaseValue}
                            onChange={e => setSalesData(prev => ({ ...prev, averageCaseValue: safeNumber(e.target.value) }))}
                            data-testid="input-case-value"
                          />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>{t("noShowRate")} (%)</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, noShowRate: !prev.noDataFlags.noShowRate }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.noShowRate 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.noShowRate ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.noShowRate ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <Input
                            type="number"
                            value={salesData.noShowRate}
                            onChange={e => setSalesData(prev => ({ ...prev, noShowRate: safeNumber(e.target.value, { max: 100 }) }))}
                            placeholder="Target: ≤25%"
                            data-testid="input-no-show-rate"
                          />
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Pipeline Momentum Index <span className="text-caption italic text-muted-foreground font-normal">(BETA)</span></Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, pipelineMomentumScore: !prev.noDataFlags.pipelineMomentumScore }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.pipelineMomentumScore 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.pipelineMomentumScore ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.pipelineMomentumScore ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <Input
                            type="number"
                            value={salesData.pipelineMomentumScore}
                            onChange={e => setSalesData(prev => ({ ...prev, pipelineMomentumScore: parseInt(e.target.value) || 0 }))}
                            placeholder="0-100"
                            data-testid="input-pipeline-momentum-score"
                          />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Sales Raw Quality Score</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, qualityScore: !prev.noDataFlags.qualityScore }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.qualityScore 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.qualityScore ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.qualityScore ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm">
                            Data Not Provided
                          </div>
                        ) : (
                          <>
                            <Input
                              type="number"
                              value={salesData.qualityScore}
                              onChange={e => setSalesData(prev => ({ ...prev, qualityScore: safeNumber(e.target.value, { max: 100 }) }))}
                              step="0.01"
                              placeholder="Raw score (e.g., 32.38)"
                            />
                          </>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Deal Touch Density</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, dealTouchDensity: !prev.noDataFlags.dealTouchDensity }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.dealTouchDensity 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.dealTouchDensity ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.dealTouchDensity ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm" data-testid="text-deal-touch-no-data">
                            Data Not Provided
                          </div>
                        ) : (
                          <DecimalInput
                            value={salesData.dealTouchDensity}
                            onCommit={n => setSalesData(prev => ({ ...prev, dealTouchDensity: n }))}
                            placeholder="e.g., 0.62"
                            data-testid="input-deal-touch-density"
                          />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Avg Age Open Matters</Label>
                          <button
                            type="button"
                            onClick={() => setSalesData(prev => ({
                              ...prev,
                              noDataFlags: { ...prev.noDataFlags, avgAgeOpenMatters: !prev.noDataFlags.avgAgeOpenMatters }
                            }))}
                            className={`text-caption px-2 py-0.5 rounded-full transition-colors ${
                              salesData.noDataFlags.avgAgeOpenMatters 
                                ? 'border border-status-warn/40 bg-status-warn/15 text-status-warn' 
                                : 'border border-transparent bg-muted text-muted-foreground hover:bg-muted/80'
                            }`}
                          >
                            {salesData.noDataFlags.avgAgeOpenMatters ? 'No Data ✓' : 'No Data?'}
                          </button>
                        </div>
                        {salesData.noDataFlags.avgAgeOpenMatters ? (
                          <div className="h-10 px-3 py-2 border border-status-warn/40 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center text-sm" data-testid="text-avg-age-no-data">
                            Data Not Provided
                          </div>
                        ) : (
                          <DecimalInput
                            value={salesData.avgAgeOpenMatters}
                            onCommit={n => setSalesData(prev => ({ ...prev, avgAgeOpenMatters: n }))}
                            placeholder="e.g., 10.44"
                            data-testid="input-avg-age-open-matters"
                          />
                        )}
                      </div>
                    </div>

                    <div className="border-t pt-4 space-y-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <Label>Common Issues</Label>
                          <div className="flex items-center gap-1">
                            {salesData.commonIssues.trim() && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditingIssues(prev => ({ ...prev, sales: !prev.sales }))}
                                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                                  data-testid="button-toggle-edit-sales-issues"
                                >
                                  <Pencil className="w-3 h-3" />
                                  {editingIssues.sales ? "Preview" : "Edit"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => formatCommonIssues(salesData.commonIssues, "sales")}
                                  disabled={formattingIssues === "sales"}
                                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary-ink hover:bg-primary/15 transition-colors disabled:opacity-50"
                                  data-testid="button-ai-format-sales"
                                >
                                  {formattingIssues === "sales" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                                  AI Format
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {editingIssues.sales || !salesData.commonIssues.trim() ? (
                          <textarea
                            className="w-full min-h-[80px] p-3 border rounded-md text-sm"
                            value={salesData.commonIssues}
                            onChange={e => setSalesData(prev => ({ ...prev, commonIssues: e.target.value }))}
                            placeholder="e.g., Low consultation-to-case conversion rate, Low follow-up activity"
                            data-testid="textarea-sales-common-issues"
                          />
                        ) : (
                          <div
                            className="w-full min-h-[80px] p-3 border rounded-md text-sm prose prose-sm max-w-none cursor-pointer hover:bg-muted/30 transition-colors [&_blockquote]:border-l-3 [&_blockquote]:border-primary/30 [&_blockquote]:bg-primary/5 [&_blockquote]:pl-3 [&_blockquote]:py-1.5 [&_blockquote]:my-1 [&_blockquote]:rounded-r-md [&_blockquote]:not-italic [&_hr]:my-3 [&_hr]:border-border [&_p]:my-1"
                            onClick={() => setEditingIssues(prev => ({ ...prev, sales: true }))}
                            data-testid="display-sales-common-issues"
                          >
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                              p: ({ children, ...props }) => {
                                const childArray = Array.isArray(children) ? children : [children];
                                const firstChild = childArray[0];
                                const trimmed = typeof firstChild === 'string' ? firstChild.trimStart() : '';
                                const isImpactLine = trimmed.startsWith('↳') || trimmed.startsWith('Impact:');
                                if (isImpactLine) {
                                  return <p className="!text-xs !text-foreground/60 !pl-5 !my-0.5 !leading-relaxed" {...props}>{children}</p>;
                                }
                                return <p {...props}>{children}</p>;
                              }
                            }}>{salesData.commonIssues}</ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>


                  </CardContent>
                </Card>
              </TabsContent>

              {/* MARKETING TAB */}
              <TabsContent value="marketing">
                <div className="space-y-4">
                  <SectionAuditInfo reportId={activeReportId} sectionKey="marketing" {...getSectionMeta("marketing")} />
                  {/* Lead Totals */}
                  {(() => {
                    const qualitySumExcludingWebinar = leadQualityExcludingWebinar.good + leadQualityExcludingWebinar.notQuotable + leadQualityExcludingWebinar.missedCalls + leadQualityExcludingWebinar.noData;
                    const totalForMismatch = totalLeadsExcludingWebinar;
                    const overallMissing = totalForMismatch - qualitySumExcludingWebinar;
                    const hasOverallMismatch = overallMissing !== 0 && (totalForMismatch > 0 || qualitySumExcludingWebinar > 0);
                    
                    // Find which specific sources have mismatches for detailed feedback
                    const mismatchSources: string[] = [];
                    if (marketingData.googleAdsEnabled) {
                      const gadsLqSum = getLeadQualitySum(marketingData.googleAds.leadQuality);
                      const gadsDiff = marketingData.googleAds.uniqueLeads - gadsLqSum;
                      if (gadsDiff !== 0 && (marketingData.googleAds.uniqueLeads > 0 || gadsLqSum > 0)) {
                        mismatchSources.push(`Google Ads (${gadsDiff > 0 ? '+' : ''}${gadsDiff})`);
                      }
                    }
                    if (marketingData.lsaEnabled) {
                      const lsaLqSum = getLeadQualitySum(marketingData.lsa.leadQuality);
                      const lsaDiff = marketingData.lsa.uniqueLeads - lsaLqSum;
                      if (lsaDiff !== 0 && (marketingData.lsa.uniqueLeads > 0 || lsaLqSum > 0)) {
                        mismatchSources.push(`LSA (${lsaDiff > 0 ? '+' : ''}${lsaDiff})`);
                      }
                    }
                    if ((marketingData.otherLeads?.count || 0) > 0) {
                      const otherLq = marketingData.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
                      const otherLqSum = getLeadQualitySum(otherLq);
                      const otherDiff = (marketingData.otherLeads?.count || 0) - otherLqSum;
                      if (otherDiff !== 0) {
                        mismatchSources.push(`Other (${otherDiff > 0 ? '+' : ''}${otherDiff})`);
                      }
                    }
                    
                    return (
                  <Card className={`bg-card border-primary/10 ${hasOverallMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center justify-between flex-wrap gap-2">
                        <span>{t("leads")} Performance</span>
                        {hasOverallMismatch && (
                          <span className="text-sm text-status-warn font-medium bg-status-warn/10 px-2 py-1 rounded">
                            {mismatchSources.length > 0 
                              ? `Mismatch in: ${mismatchSources.join(', ')}` 
                              : `${Math.abs(overallMissing)} leads ${overallMissing > 0 ? 'missing quality status' : 'over-counted'}`}
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription>Overall lead generation and quality metrics</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
                        <div>
                          <Label>Total {t("leads")}</Label>
                          <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md text-foreground font-semibold flex items-center">
                            {totalLeadsExcludingWebinar}
                          </div>
                          {hasWebinarProduct && webinarLeadCount > 0 && (
                            <div className="text-caption text-muted-foreground mt-1">
                              + {hasWebinarLeadQuality ? webinarLeadCount + ' webinar leads (' + Math.ceil(webinarLeadCount * WEBINAR_LEAD_EQUIVALENCY) + ' lead equiv.)' : (marketingData.webinar.hotTransfers || 0) + ' HT (' + Math.ceil((marketingData.webinar.hotTransfers || 0) * WEBINAR_LEAD_EQUIVALENCY) + ' lead equiv.)'}
                            </div>
                          )}
                        </div>
                        <div>
                          <Label className="text-sm text-status-ok">Good</Label>
                          <div className="h-10 px-3 py-2 bg-status-ok/10 rounded-md text-status-ok font-medium flex items-center">
                            {leadQualityExcludingWebinar.good}
                          </div>
                        </div>
                        <div>
                          <Label className="text-sm text-status-warn">Not Quotable</Label>
                          <div className="h-10 px-3 py-2 bg-status-warn/10 rounded-md text-status-warn font-medium flex items-center">
                            {leadQualityExcludingWebinar.notQuotable}
                          </div>
                        </div>
                        <div>
                          <Label className="text-sm text-status-critical">Missed Calls</Label>
                          <div className="h-10 px-3 py-2 bg-status-critical/10 rounded-md text-status-critical font-medium flex items-center">
                            {leadQualityExcludingWebinar.missedCalls}
                          </div>
                        </div>
                        <div>
                          <Label className="text-sm text-muted-foreground">No Data</Label>
                          <div className="h-10 px-3 py-2 bg-muted/50 rounded-md text-muted-foreground font-medium flex items-center">
                            {leadQualityExcludingWebinar.noData}
                          </div>
                        </div>
                      </div>
                      {hasWebinarProduct && webinarLeadCount > 0 && (
                        <div className="text-xs text-muted-foreground bg-status-warn/10 rounded-md px-3 py-2">
                          Webinar ({hasWebinarLeadQuality ? webinarLeadCount + ' leads' : (marketingData.webinar.hotTransfers || 0) + ' HT'}): shown separately
                          {hasWebinarLeadQuality && (
                            <span className="ml-1">— {marketingData.webinar?.leadQuality?.good || 0} good, {marketingData.webinar?.leadQuality?.notQuotable || 0} not quotable, {marketingData.webinar?.leadQuality?.missedCalls || 0} missed, {marketingData.webinar?.leadQuality?.noData || 0} no data</span>
                          )}
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">Totals are auto-calculated from individual sources below (excludes webinar)</p>
                    </CardContent>
                  </Card>
                    );
                  })()}

                  {/* Marketing Posture Selection */}
                  <Card className={`bg-card ${!marketingData.posture ? "border-status-warn/60 border-2" : "border-primary/10"}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center gap-2">
                        Marketing Posture
                        {!marketingData.posture && (
                          <span className="text-xs font-normal text-status-warn bg-status-warn/10 px-2 py-0.5 rounded-full">Not set</span>
                        )}
                      </CardTitle>
                      <CardDescription>Current marketing strategy focus for this client</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {/* One calm selected accent for all postures — the label carries the
                          meaning; per-option pastel hues ghosted in dark mode and made the
                          picker read like four different statuses. */}
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        {[
                          { value: "baseline", label: "Establishing Baseline", desc: "Collecting initial data" },
                          { value: "ramp-up", label: "Ramp-Up", desc: "New campaign or reactivation" },
                          { value: "scaling", label: "Scaling", desc: "Aggressive growth phase" },
                          { value: "stable", label: "Stable", desc: "Maintaining current performance" },
                        ].map(option => (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={marketingData.posture === option.value}
                            onClick={() => setMarketingData(prev => ({ ...prev, posture: option.value as "baseline" | "ramp-up" | "stable" | "scaling" }))}
                            className={`p-4 rounded-lg border-2 text-left transition-all ${
                              marketingData.posture === option.value 
                                ? "border-primary bg-primary/10 text-primary-ink ring-2 ring-offset-1 ring-primary/30"
                                : "border-border bg-card hover:border-primary/40"
                            }`}
                          >
                            <div className="font-semibold text-sm">{option.label}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{option.desc}</div>
                          </button>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  {inactiveProductLeadSources.length > 0 && !inactiveLeadsDismissed && (
                    <Alert className="border-status-warn/40 bg-status-warn/10 cursor-pointer" onClick={() => {
                      const productsToAdd: string[] = [];
                      if (inactiveProductLeadSources.includes("Google Ads")) productsToAdd.push("google_ads");
                      if (inactiveProductLeadSources.includes("LSA")) productsToAdd.push("lsa");
                      if (inactiveProductLeadSources.includes("GBP")) productsToAdd.push("gbp");
                      if (inactiveProductLeadSources.includes("Webinar")) productsToAdd.push("webinar");
                      setSelectedProductsToAdd(productsToAdd);
                      setInactiveLeadsDialogOpen(true);
                    }}>
                      <AlertTriangle className="h-4 w-4 text-status-warn" />
                      <AlertTitle className="text-foreground">Leads from non-active products detected</AlertTitle>
                      <AlertDescription className="text-status-warn">
                        This report has leads from: <strong>{inactiveProductLeadSources.join(", ")}</strong>. These are currently rolled into "Other." Click here to update the client's products or dismiss.
                      </AlertDescription>
                    </Alert>
                  )}

                  {/* GBP Locations - Only show if product purchased */}
                  {clientProducts.includes("gbp") && (
                  <Card className="bg-card border-primary/10">
                    <CardHeader>
                      <CardTitle className="text-foreground">GBP Locations</CardTitle>
                      <CardDescription>Google Business Profile metrics per location</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {unresolvedGbpImports.length > 0 && (
                        <div
                          className="mb-4 p-3 rounded-lg bg-status-warn/10 border border-status-warn/40 text-foreground"
                          data-testid="banner-unresolved-gbp-imports"
                        >
                          <div className="flex items-start gap-2">
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                            <div className="text-sm">
                              <p className="font-medium">
                                {unresolvedGbpImports.length} imported location(s) weren't added
                              </p>
                              <p className="mt-1">
                                These locations from the PDF don't match this client's command panel and were
                                <span className="font-medium"> not added</span> to the report:{" "}
                                <span className="font-medium">{unresolvedGbpImports.join(", ")}</span>.
                                If they belong to this client, add them in Client Management, then re-import.
                                Otherwise the PDF may be from the wrong source — discard this message.
                              </p>
                              <button
                                type="button"
                                className="mt-2 text-xs underline"
                                onClick={() => setUnresolvedGbpImports([])}
                                data-testid="button-dismiss-unresolved-gbp"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {marketingData.gbpLocations.length === 0 ? (
                        <p className="text-muted-foreground">No GBP locations configured for this client. Add locations in Client Management first.</p>
                      ) : (
                        <div className="space-y-4">
                          {(() => {
                            // Pre-compute the first index where each (id | normalized name)
                            // appears so later occurrences can be tagged as duplicates.
                            const firstIndexByKey = new Map<string, number>();
                            marketingData.gbpLocations.forEach((l, i) => {
                              const key = `${l.id}|${(l.name || "").toLowerCase().trim()}`;
                              if (!firstIndexByKey.has(key)) firstIndexByKey.set(key, i);
                            });
                            return marketingData.gbpLocations.map((loc, idx) => {
                            // Treat the command-panel list as authoritative once it has loaded
                            // (clientLocations !== undefined). An empty list means the report
                            // row has no match and is therefore stale.
                            const isStale = clientLocations !== undefined &&
                              !clientLocations.some(cl =>
                                cl.id === loc.id ||
                                cl.name?.toLowerCase().trim() === loc.name?.toLowerCase().trim()
                              );
                            const dupKey = `${loc.id}|${(loc.name || "").toLowerCase().trim()}`;
                            const isDuplicate = firstIndexByKey.get(dupKey) !== idx;
                            return (
                            <div key={`${loc.id}-${idx}`} className="p-4 rounded-lg bg-surface-warm-1" data-testid={`row-gbp-location-${loc.id}-${idx}`}>
                              <div className="flex items-start justify-between gap-3 mb-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-medium text-foreground" data-testid={`text-gbp-location-name-${loc.id}-${idx}`}>{loc.name}</p>
                                  {isStale && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption font-medium bg-status-warn/15 text-status-warn border border-status-warn/40"
                                      title="This location is no longer in the client's command panel"
                                      data-testid={`badge-stale-location-${loc.id}-${idx}`}
                                    >
                                      <AlertTriangle className="w-3 h-3" />
                                      Not in command panel
                                    </span>
                                  )}
                                  {isDuplicate && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-caption font-medium bg-status-warn/15 text-status-warn border border-status-warn/40"
                                      title="Another row in this report already represents this location"
                                      data-testid={`badge-duplicate-location-${loc.id}-${idx}`}
                                    >
                                      <Copy className="w-3 h-3" />
                                      Duplicate
                                    </span>
                                  )}
                                </div>
                                <ConfirmActionDialog
                                  title={`Remove "${loc.name}" from this report?`}
                                  description="Any metrics entered for this location in the report are lost. The location itself stays in the client's command panel and can be re-added."
                                  confirmLabel="Remove location"
                                  testId={`dialog-confirm-remove-gbp-location-${loc.id}`}
                                  onConfirm={() => {
                                    setMarketingData(prev => ({
                                      ...prev,
                                      gbpLocations: prev.gbpLocations.filter((_, i) => i !== idx),
                                    }));
                                  }}
                                  trigger={
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 text-status-critical hover:text-status-critical hover:bg-status-critical/10"
                                      data-testid={`button-remove-gbp-location-${loc.id}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5 mr-1" />
                                      <span className="text-xs">Remove</span>
                                    </Button>
                                  }
                                />
                              </div>
                              {isStale && (
                                <div className="mb-3" data-testid={`add-to-command-panel-${loc.id}-${idx}`}>
                                  {addToCpIdx === idx ? (
                                    <div className="p-3 rounded-lg bg-card border border-status-warn/40 space-y-2">
                                      <div>
                                        <Label className="text-xs text-muted-foreground">Location Name</Label>
                                        <Input
                                          value={loc.name}
                                          disabled
                                          className="h-8 text-sm bg-surface-warm-1"
                                          data-testid={`input-add-cp-name-${loc.id}-${idx}`}
                                        />
                                      </div>
                                      <div>
                                        <Label className="text-xs text-muted-foreground">Full Address *</Label>
                                        <Input
                                          placeholder="123 Main St, Dallas, TX 75201"
                                          value={addToCpAddress}
                                          onChange={e => { setAddToCpAddress(e.target.value); setAddToCpError(""); }}
                                          className="h-8 text-sm"
                                          data-testid={`input-add-cp-address-${loc.id}-${idx}`}
                                        />
                                        <p className="text-caption text-muted-foreground mt-1">
                                          A full, geocodable US street address is required — include street, city, state, and ZIP.
                                        </p>
                                      </div>
                                      {addToCpError && (
                                        <p className="text-xs text-status-critical" data-testid={`text-add-cp-error-${loc.id}-${idx}`}>{addToCpError}</p>
                                      )}
                                      <div className="flex gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          className="bg-primary hover:bg-primary/90 h-7 text-xs"
                                          disabled={addToCpAddress.trim().length < 10 || addStaleLocationMutation.isPending}
                                          onClick={() => { setAddToCpError(""); addStaleLocationMutation.mutate({ idx, name: loc.name, address: addToCpAddress.trim() }); }}
                                          data-testid={`button-save-add-cp-${loc.id}-${idx}`}
                                        >
                                          {addStaleLocationMutation.isPending ? "Validating address..." : "Add to command panel"}
                                        </Button>
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-xs"
                                          onClick={() => { setAddToCpIdx(null); setAddToCpAddress(""); setAddToCpError(""); }}
                                          data-testid={`button-cancel-add-cp-${loc.id}-${idx}`}
                                        >
                                          Cancel
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs border-status-warn/50 text-status-warn hover:bg-status-warn/10"
                                      onClick={() => { setAddToCpIdx(idx); setAddToCpAddress(""); setAddToCpError(""); }}
                                      data-testid={`button-add-to-command-panel-${loc.id}-${idx}`}
                                    >
                                      <Plus className="w-3 h-3 mr-1" />
                                      Add to command panel
                                    </Button>
                                  )}
                                </div>
                              )}
                              <div className="grid grid-cols-4 gap-3">
                                <div>
                                  <Label className="text-xs">Unique Leads</Label>
                                  <Input
                                    type="number"
                                    value={loc.uniqueLeads}
                                    onChange={e => {
                                      const updated = [...marketingData.gbpLocations];
                                      updated[idx] = { ...loc, uniqueLeads: parseInt(e.target.value) || 0 };
                                      setMarketingData(prev => ({ ...prev, gbpLocations: updated }));
                                    }}
                                  />
                                </div>
                                <div>
                                  <Label className="text-xs">Reviews Generated</Label>
                                  <Input
                                    type="number"
                                    value={loc.reviewsGenerated}
                                    onChange={e => {
                                      const updated = [...marketingData.gbpLocations];
                                      updated[idx] = { ...loc, reviewsGenerated: parseInt(e.target.value) || 0 };
                                      setMarketingData(prev => ({ ...prev, gbpLocations: updated }));
                                    }}
                                  />
                                </div>
                                <div>
                                  <Label className="text-xs">Reviews Responded</Label>
                                  <Input
                                    type="number"
                                    value={loc.reviewsRespondedTo}
                                    onChange={e => {
                                      const updated = [...marketingData.gbpLocations];
                                      updated[idx] = { ...loc, reviewsRespondedTo: parseInt(e.target.value) || 0 };
                                      setMarketingData(prev => ({ ...prev, gbpLocations: updated }));
                                    }}
                                  />
                                </div>
                                <div>
                                  <Label className="text-xs">Posts/Q&A Count</Label>
                                  <Input
                                    type="number"
                                    value={loc.postsQaCount}
                                    onChange={e => {
                                      const updated = [...marketingData.gbpLocations];
                                      updated[idx] = { ...loc, postsQaCount: parseInt(e.target.value) || 0 };
                                      setMarketingData(prev => ({ ...prev, gbpLocations: updated }));
                                    }}
                                  />
                                </div>
                              </div>
                              
                              {/* Heatmap Section */}
                              <div className="mt-4 pt-3 border-t border-primary/10">
                                <div className="flex items-center justify-between mb-2">
                                  <Label className="text-xs text-muted-foreground">
                                    Location Heatmap{(loc.heatmapSnapshotIds?.length || 0) > 1 ? "s" : ""}
                                    {(loc.heatmapSnapshotIds?.length || 0) > 0 && (
                                      <span className="ml-1.5 text-caption text-status-ok font-normal">
                                        ({loc.heatmapSnapshotIds!.length} keyword{loc.heatmapSnapshotIds!.length !== 1 ? "s" : ""})
                                      </span>
                                    )}
                                  </Label>
                                  <div className="flex items-center gap-1.5">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-xs gap-1.5 border-primary/30 text-primary-ink hover:bg-primary/5"
                                      onClick={() => {
                                        setHeatmapPickerLocationIdx(idx);
                                        setHeatmapPickerLocationName(loc.name);
                                        setHeatmapPickerLocationId(loc.id);
                                        setHeatmapPickerOpen(true);
                                      }}
                                      data-testid={`heatmap-get-btn-${idx}`}
                                    >
                                      <Grid3X3 className="w-3 h-3" />
                                      {(loc.heatmapSnapshotIds?.length || 0) > 0 ? "Update" : "Get"} Heatmap{(loc.heatmapSnapshotIds?.length || 0) > 1 ? "s" : ""}
                                    </Button>
                                    {(loc.heatmapSnapshotIds?.length || 0) > 0 && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMarketingData(prev => {
                                            const updated = [...prev.gbpLocations];
                                            updated[idx] = { ...updated[idx], heatmapSnapshotIds: [], heatmapSnapshotId: undefined };
                                            return { ...prev, gbpLocations: updated };
                                          });
                                        }}
                                        className="p-1 hover:bg-status-critical/15 rounded-full transition-colors"
                                        title="Remove all heatmaps"
                                        aria-label="Remove all heatmaps"
                                        data-testid={`heatmap-remove-all-${idx}`}
                                      >
                                        <X className="w-3.5 h-3.5 text-status-critical" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div>
                                  {(loc.heatmapSnapshotIds?.length || 0) > 0 ? (
                                    <LocationHeatmapTabs
                                      snapshotIds={loc.heatmapSnapshotIds!}
                                      locationIdx={idx}
                                    />
                                  ) : loc.heatmapImageUrl ? (
                                    <div className="relative">
                                      <img 
                                        src={loc.heatmapImageUrl} 
                                        alt={`${loc.name} Heatmap`}
                                        className="w-full h-32 object-cover rounded-lg border border-border"
                                      />
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setMarketingData(prev => {
                                            const updated = [...prev.gbpLocations];
                                            updated[idx] = { ...updated[idx], heatmapImageUrl: undefined };
                                            return { ...prev, gbpLocations: updated };
                                          });
                                        }}
                                        className="absolute top-2 right-2 p-1 bg-card/90 rounded-full hover:bg-status-critical/15 transition-colors"
                                        title="Remove heatmap"
                                        aria-label="Remove heatmap"
                                      >
                                        <X className="w-4 h-4 text-status-critical" />
                                      </button>
                                    </div>
                                  ) : (
                                    <ObjectUploader
                                      maxNumberOfFiles={1}
                                      maxFileSize={5242880}
                                      buttonClassName="h-16 w-full border-2 border-dashed border-border bg-muted/50 hover:bg-muted text-muted-foreground flex flex-col items-center justify-center gap-1"
                                      onGetUploadParameters={async (file) => {
                                        const res = await fetch("/api/object-storage/presigned-url", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          credentials: "include",
                                          body: JSON.stringify({
                                            fileName: file.name,
                                            contentType: file.type,
                                            directory: "heatmaps",
                                          }),
                                        });
                                        if (!res.ok) throw new Error("Failed to get upload URL");
                                        const { uploadUrl, publicUrl } = await res.json();
                                        file.meta.publicUrl = publicUrl;
                                        return { method: "PUT" as const, url: uploadUrl };
                                      }}
                                      onComplete={(result) => {
                                        const uploadedFile = result.successful?.[0];
                                        if (uploadedFile) {
                                          const publicUrl = (uploadedFile.meta as { publicUrl?: string })?.publicUrl;
                                          if (publicUrl) {
                                            // Task #2493: presigned uploads carry no ACL, so the
                                            // serving route treats them as private and the <img>
                                            // 401/403s. Mark this specific object public so it
                                            // renders here and in the public report.
                                            // Task #4544: the claim endpoint now REJECTS files
                                            // that don't sniff as map-scan screenshots (e.g. a
                                            // portrait photo) — surface that instead of storing a
                                            // reference the report would hide as "scan pending".
                                            void (async () => {
                                              try {
                                                const claim = await fetch("/api/object-storage/heatmap-public", {
                                                  method: "POST",
                                                  headers: { "Content-Type": "application/json" },
                                                  credentials: "include",
                                                  body: JSON.stringify({ objectPath: publicUrl }),
                                                });
                                                if (!claim.ok) {
                                                  const body = await claim.json().catch(() => ({}));
                                                  toast({
                                                    title: "Not a map scan",
                                                    description: body?.error || "Upload rejected — map scans must be PNG screenshots.",
                                                    variant: "destructive",
                                                  });
                                                  return;
                                                }
                                              } catch {
                                                // Network hiccup: keep the legacy best-effort
                                                // behavior (the lazy report-read heal covers it).
                                              }
                                              setMarketingData(prev => {
                                                const updated = [...prev.gbpLocations];
                                                updated[idx] = { ...updated[idx], heatmapImageUrl: publicUrl };
                                                return { ...prev, gbpLocations: updated };
                                              });
                                              setPendingHeatmapSave({ idx, url: publicUrl });
                                              toast({ title: "Heatmap uploaded", description: `Saving ${loc.name} heatmap...` });
                                            })();
                                          }
                                        }
                                      }}
                                    >
                                      <Upload className="w-4 h-4" />
                                      <span className="text-caption">or Upload PNG</span>
                                    </ObjectUploader>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                          });
                          })()}
                        </div>
                      )}
                      <div className="mt-4 pt-4 border-t">
                        <Label>Blog Post URL (Optional)</Label>
                        <Input
                          placeholder="https://..."
                          value={marketingData.blogPostUrl}
                          onChange={e => setMarketingData(prev => ({ ...prev, blogPostUrl: e.target.value }))}
                          className="mt-1"
                        />
                      </div>
                      
                      {/* GBP Lead Quality - Combined for all locations */}
                      {marketingData.gbpLocations.length > 0 && (() => {
                        const gbpTotalLeads = marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.uniqueLeads || 0), 0);
                        const gbpQualitySum = (marketingData.leadQuality?.good || 0) + (marketingData.leadQuality?.notQuotable || 0) + (marketingData.leadQuality?.missedCalls || 0) + (marketingData.leadQuality?.noData || 0);
                        const gbpMismatch = gbpTotalLeads !== gbpQualitySum && (gbpTotalLeads > 0 || gbpQualitySum > 0);
                        const gbpDiff = gbpTotalLeads - gbpQualitySum;
                        return (
                        <div className={`mt-4 pt-4 border-t ${gbpMismatch ? 'bg-status-warn/10 -mx-4 px-4 rounded-lg' : ''}`}>
                          <div className="flex items-center justify-between mb-2">
                            <div>
                              <Label className="text-sm font-medium text-foreground">GBP {t("leads")} Quality (Combined)</Label>
                              <p className="text-xs text-muted-foreground">Enter combined {t("leads").toLowerCase()} quality for all GBP {t("leads").toLowerCase()} ({gbpTotalLeads} total)</p>
                            </div>
                            {gbpMismatch && (
                              <span className="text-xs text-status-warn font-medium bg-status-warn/15 px-2 py-1 rounded">
                                {gbpDiff > 0 ? `${gbpDiff} ${t("leads").toLowerCase()} missing quality status` : `Quality exceeds ${t("leads").toLowerCase()} by ${Math.abs(gbpDiff)}`}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-4 gap-3">
                            <div>
                              <Label className="text-xs text-status-ok">Good</Label>
                              <Input
                                type="number"
                                value={marketingData.leadQuality?.good || 0}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  leadQuality: { ...prev.leadQuality, good: parseInt(e.target.value) || 0 }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-warn">Not Quotable</Label>
                              <Input
                                type="number"
                                value={marketingData.leadQuality?.notQuotable || 0}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  leadQuality: { ...prev.leadQuality, notQuotable: parseInt(e.target.value) || 0 }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-critical">Missed</Label>
                              <Input
                                type="number"
                                value={marketingData.leadQuality?.missedCalls || 0}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  leadQuality: { ...prev.leadQuality, missedCalls: parseInt(e.target.value) || 0 }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">No Data</Label>
                              <Input
                                type="number"
                                value={marketingData.leadQuality?.noData || 0}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  leadQuality: { ...prev.leadQuality, noData: parseInt(e.target.value) || 0 }
                                }))}
                              />
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                  )}

                  {/* Channel Visibility Toggles - Only show if product purchased */}
                  {hasPaidProduct && (
                    <Card className="bg-card border-primary/10">
                      <CardHeader>
                        <CardTitle className="text-foreground text-base">Paid Channels for This Report</CardTitle>
                        <CardDescription>Toggle which paid channels to include in this month's report</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap gap-6">
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={marketingData.googleAdsEnabled}
                              onCheckedChange={(checked) => setMarketingData(prev => ({ ...prev, googleAdsEnabled: checked }))}
                              data-testid="switch-google-ads"
                            />
                            <Label className="font-medium">Google Ads</Label>
                          </div>
                          <div className="flex items-center gap-3">
                            <Switch
                              checked={marketingData.lsaEnabled}
                              onCheckedChange={(checked) => setMarketingData(prev => ({ ...prev, lsaEnabled: checked }))}
                              data-testid="switch-lsa"
                            />
                            <Label className="font-medium">Local Service Ads (LSA)</Label>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Google Ads - Only show if product purchased AND enabled */}
                  {hasGoogleAdsProduct && marketingData.googleAdsEnabled && (() => {
                    const gadsLqSum = getLeadQualitySum(marketingData.googleAds.leadQuality);
                    const gadsMismatch = gadsLqSum !== marketingData.googleAds.uniqueLeads && (marketingData.googleAds.uniqueLeads > 0 || gadsLqSum > 0);
                    return (
                  <Card className={`bg-card border-primary/10 ${gadsMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center justify-between">
                        <span>Google Ads</span>
                        {gadsMismatch && (
                          <span className="text-xs text-status-warn font-medium">
                            Quality ({gadsLqSum}) ≠ Leads ({marketingData.googleAds.uniqueLeads})
                          </span>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                        <div>
                          <Label>Unique Leads</Label>
                          <Input
                            type="number"
                            value={marketingData.googleAds.uniqueLeads}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              googleAds: { ...prev.googleAds, uniqueLeads: parseInt(e.target.value) || 0 }
                            }))}
                          />
                        </div>
                        <div>
                          <Label>Ad Spend ($)</Label>
                          <DecimalInput
                            value={marketingData.googleAds.adSpend}
                            onCommit={n => setMarketingData(prev => ({
                              ...prev,
                              googleAds: { ...prev.googleAds, adSpend: n }
                            }))}
                            data-testid="input-google-ads-spend"
                          />
                        </div>
                        <div>
                          <Label>Cost Per {t("leads")}</Label>
                          <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold">
                            ${googleAdsCostPerLead}
                          </div>
                        </div>
                        <div className="col-span-4">
                          <Label className="text-sm">{t("leads")} Quality Breakdown</Label>
                          <div className="grid grid-cols-4 gap-2 mt-1">
                            <div>
                              <Label className="text-xs text-status-ok">Good</Label>
                              <Input
                                type="number"
                                value={marketingData.googleAds.leadQuality.good}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  googleAds: { ...prev.googleAds, leadQuality: { ...prev.googleAds.leadQuality, good: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-warn">Not Quotable</Label>
                              <Input
                                type="number"
                                value={marketingData.googleAds.leadQuality.notQuotable}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  googleAds: { ...prev.googleAds, leadQuality: { ...prev.googleAds.leadQuality, notQuotable: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-critical">Missed</Label>
                              <Input
                                type="number"
                                value={marketingData.googleAds.leadQuality.missedCalls}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  googleAds: { ...prev.googleAds, leadQuality: { ...prev.googleAds.leadQuality, missedCalls: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">No Data</Label>
                              <Input
                                type="number"
                                value={marketingData.googleAds.leadQuality.noData}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  googleAds: { ...prev.googleAds, leadQuality: { ...prev.googleAds.leadQuality, noData: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  );
                  })()}

                  {/* LSA - Only show if product purchased AND enabled */}
                  {hasLsaProduct && marketingData.lsaEnabled && (() => {
                    const lsaLqSum = getLeadQualitySum(marketingData.lsa.leadQuality);
                    const lsaMismatch = lsaLqSum !== marketingData.lsa.uniqueLeads && (marketingData.lsa.uniqueLeads > 0 || lsaLqSum > 0);
                    return (
                  <Card className={`bg-card border-primary/10 ${lsaMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center justify-between">
                        <span>Local Service Ads (LSA)</span>
                        {lsaMismatch && (
                          <span className="text-xs text-status-warn font-medium">
                            Quality ({lsaLqSum}) ≠ Leads ({marketingData.lsa.uniqueLeads})
                          </span>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                        <div>
                          <Label>Unique Leads</Label>
                          <Input
                            type="number"
                            value={marketingData.lsa.uniqueLeads}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              lsa: { ...prev.lsa, uniqueLeads: parseInt(e.target.value) || 0 }
                            }))}
                          />
                        </div>
                        <div>
                          <Label>Ad Spend ($)</Label>
                          <DecimalInput
                            value={marketingData.lsa.adSpend}
                            onCommit={n => setMarketingData(prev => ({
                              ...prev,
                              lsa: { ...prev.lsa, adSpend: n }
                            }))}
                            data-testid="input-lsa-ad-spend"
                          />
                        </div>
                        <div>
                          <Label>Cost Per {t("leads")}</Label>
                          <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold">
                            ${lsaCostPerLead}
                          </div>
                        </div>
                        <div className="col-span-4">
                          <Label className="text-sm">{t("leads")} Quality Breakdown</Label>
                          <div className="grid grid-cols-4 gap-2 mt-1">
                            <div>
                              <Label className="text-xs text-status-ok">Good</Label>
                              <Input
                                type="number"
                                value={marketingData.lsa.leadQuality.good}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  lsa: { ...prev.lsa, leadQuality: { ...prev.lsa.leadQuality, good: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-warn">Not Quotable</Label>
                              <Input
                                type="number"
                                value={marketingData.lsa.leadQuality.notQuotable}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  lsa: { ...prev.lsa, leadQuality: { ...prev.lsa.leadQuality, notQuotable: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-critical">Missed</Label>
                              <Input
                                type="number"
                                value={marketingData.lsa.leadQuality.missedCalls}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  lsa: { ...prev.lsa, leadQuality: { ...prev.lsa.leadQuality, missedCalls: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">No Data</Label>
                              <Input
                                type="number"
                                value={marketingData.lsa.leadQuality.noData}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  lsa: { ...prev.lsa, leadQuality: { ...prev.lsa.leadQuality, noData: parseInt(e.target.value) || 0 } }
                                }))}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  );
                  })()}

                  {/* Webinars - Only show if product purchased */}
                  {clientProducts.includes("webinar") && (() => {
                    const webinarLqSum = getLeadQualitySum(marketingData.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 });
                    const webinarMismatch = webinarLqSum > 0 && webinarLqSum !== (marketingData.webinar.hotTransfers || 0);
                    return (
                  <Card className={`bg-card border-primary/10 ${webinarMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center justify-between">
                        <span>Webinars</span>
                        {webinarMismatch && (
                          <span className="text-xs text-status-warn font-medium">
                            Lead Quality ({webinarLqSum}) ≠ Hot Transfers ({marketingData.webinar.hotTransfers || 0})
                          </span>
                        )}
                      </CardTitle>
                      {webinarMismatch && (
                        <CardDescription className="text-status-warn text-xs mt-1">
                          The Lead Quality breakdown sum ({webinarLqSum}) drives all displayed lead totals — Hot Transfers is the fallback only when the breakdown is all zeros.
                        </CardDescription>
                      )}
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 sm:gap-4">
                        <div>
                          <Label>Registrants</Label>
                          <Input
                            type="number"
                            value={marketingData.webinar.registrants}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              webinar: { ...prev.webinar, registrants: parseInt(e.target.value) || 0 }
                            }))}
                          />
                        </div>
                        <div>
                          <Label>Attendees</Label>
                          <Input
                            type="number"
                            value={marketingData.webinar.attendees}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              webinar: { ...prev.webinar, attendees: parseInt(e.target.value) || 0 }
                            }))}
                          />
                        </div>
                        <div>
                          <Label>Show Rate</Label>
                          <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold">
                            {webinarShowRate}%
                          </div>
                        </div>
                        <div>
                          <Label>Hot Transfers</Label>
                          <Input
                            type="number"
                            value={marketingData.webinar.hotTransfers || ""}
                            onFocus={e => e.target.select()}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              webinar: { ...prev.webinar, hotTransfers: parseInt(e.target.value) || 0 }
                            }))}
                            data-testid="input-webinar-hot-transfers"
                          />
                        </div>
                        <div>
                          <Label>Hot Transfer Rate</Label>
                          <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold">
                            {webinarHotTransferRate}%
                          </div>
                        </div>
                        <div className="col-span-2 sm:col-span-5">
                          <Label className="text-sm">{t("leads")} Quality Breakdown <span className="text-xs text-muted-foreground/70 font-normal">(drives lead totals when sum &gt; 0; set all to 0 to fall back to Hot Transfers)</span></Label>
                          <div className="grid grid-cols-4 gap-2 mt-1">
                            <div>
                              <Label className="text-xs text-status-ok">Good</Label>
                              <Input
                                type="number"
                                value={(marketingData.webinar.leadQuality?.good) ?? 0}
                                onFocus={e => e.target.select()}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  webinar: { ...prev.webinar, leadQuality: { ...(prev.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), good: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-webinar-lq-good"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-warn">Not Quotable</Label>
                              <Input
                                type="number"
                                value={(marketingData.webinar.leadQuality?.notQuotable) ?? 0}
                                onFocus={e => e.target.select()}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  webinar: { ...prev.webinar, leadQuality: { ...(prev.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), notQuotable: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-webinar-lq-not-quotable"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-critical">Missed</Label>
                              <Input
                                type="number"
                                value={(marketingData.webinar.leadQuality?.missedCalls) ?? 0}
                                onFocus={e => e.target.select()}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  webinar: { ...prev.webinar, leadQuality: { ...(prev.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), missedCalls: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-webinar-lq-missed"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">No Data</Label>
                              <Input
                                type="number"
                                value={(marketingData.webinar.leadQuality?.noData) ?? 0}
                                onFocus={e => e.target.select()}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  webinar: { ...prev.webinar, leadQuality: { ...(prev.webinar.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), noData: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-webinar-lq-no-data"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  );
                  })()}

                  {/* Review Generation */}
                  <Card className={`bg-card border-primary/10 ${reviewCountMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground">Review Generation</CardTitle>
                      <CardDescription>
                        Total Reviews: {effectiveTotalReviews} | GBP Locations: {totalGbpReviews}
                        {reviewCountMismatch && (
                          <span className="text-status-warn font-medium ml-2">
                            (Mismatch - these should match)
                          </span>
                        )}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">List Contacted</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.listContacted || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, listContacted: parseInt(e.target.value) || 0 }
                              }))}
                              data-testid="input-review-list-contacted"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Reviews</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.totalReviews || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, totalReviews: parseInt(e.target.value) || 0 }
                              }))}
                              data-testid="input-review-total"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Webinar Reviews</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.webinarReviews || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, webinarReviews: parseInt(e.target.value) || 0 }
                              }))}
                              data-testid="input-review-webinar"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Other Reviews</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.otherCount || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, otherCount: parseInt(e.target.value) || 0 }
                              }))}
                              data-testid="input-review-other"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">List Reviews</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.listReviews || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, listReviews: parseInt(e.target.value) || 0 }
                              }))}
                              data-testid="input-review-list"
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">List Activation</Label>
                            <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold text-sm">
                              {listActivationRate}%
                            </div>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Webinar Activation</Label>
                            <div className="h-10 px-3 py-2 bg-surface-warm-1 rounded-md font-semibold text-sm">
                              {webinarActivationRate}%
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">Based on {marketingData.webinar.attendees} attendees</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">Monthly Review Target</Label>
                            <Input
                              type="number"
                              value={marketingData.reviewGeneration.monthlyTarget || ""}
                              onFocus={e => e.target.select()}
                              onChange={e => setMarketingData(prev => ({
                                ...prev,
                                reviewGeneration: { ...prev.reviewGeneration, monthlyTarget: parseInt(e.target.value) || 0 }
                              }))}
                              placeholder="e.g. 20"
                              data-testid="input-review-monthly-target"
                            />
                            <p className="text-xs text-muted-foreground mt-1">Reviews/month goal — drives the green/yellow/red velocity band on the client report. Leave blank to use the client's default target (set on the client page).</p>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Other Leads (always shown) */}
                  {(() => {
                    const otherLq = marketingData.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 };
                    const otherLqSum = getLeadQualitySum(otherLq);
                    const otherCount = marketingData.otherLeads?.count || 0;
                    const otherMismatch = otherLqSum !== otherCount && (otherCount > 0 || otherLqSum > 0);
                    return (
                  <Card className={`bg-card border-primary/10 ${otherMismatch ? 'border-status-warn/60 border-2' : ''}`}>
                    <CardHeader>
                      <CardTitle className="text-foreground flex items-center justify-between">
                        <span>Other {t("leads")}</span>
                        {otherMismatch && (
                          <span className="text-xs text-status-warn font-medium">
                            Quality ({otherLqSum}) ≠ {t("leads")} ({otherCount})
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription>{t("leads")} from sources not generated by our services (referrals, direct calls, etc.)</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <Label>{t("leads")} Count</Label>
                          <Input
                            type="number"
                            value={marketingData.otherLeads?.count || ""}
                            onFocus={e => e.target.select()}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              otherLeads: { ...prev.otherLeads, count: parseInt(e.target.value) || 0 }
                            }))}
                            placeholder="0"
                            data-testid="input-other-leads-count"
                          />
                        </div>
                        <div>
                          <Label>Source Description</Label>
                          <Input
                            value={marketingData.otherLeads?.description || ""}
                            onChange={e => setMarketingData(prev => ({
                              ...prev,
                              otherLeads: { ...prev.otherLeads, description: e.target.value }
                            }))}
                            placeholder="e.g., Referrals, Direct Calls, Social Media..."
                            data-testid="input-other-leads-description"
                          />
                        </div>
                      </div>
                      {otherCount > 0 && (
                        <div>
                          <Label className="text-sm">{t("leads")} Quality Breakdown</Label>
                          <div className="grid grid-cols-4 gap-2 mt-1">
                            <div>
                              <Label className="text-xs text-status-ok">Good</Label>
                              <Input
                                type="number"
                                value={otherLq.good}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  otherLeads: { ...prev.otherLeads, leadQuality: { ...(prev.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), good: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-other-leads-lq-good"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-warn">Not Quotable</Label>
                              <Input
                                type="number"
                                value={otherLq.notQuotable}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  otherLeads: { ...prev.otherLeads, leadQuality: { ...(prev.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), notQuotable: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-other-leads-lq-nq"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-status-critical">Missed</Label>
                              <Input
                                type="number"
                                value={otherLq.missedCalls}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  otherLeads: { ...prev.otherLeads, leadQuality: { ...(prev.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), missedCalls: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-other-leads-lq-missed"
                              />
                            </div>
                            <div>
                              <Label className="text-xs text-muted-foreground">No Data</Label>
                              <Input
                                type="number"
                                value={otherLq.noData}
                                onChange={e => setMarketingData(prev => ({
                                  ...prev,
                                  otherLeads: { ...prev.otherLeads, leadQuality: { ...(prev.otherLeads?.leadQuality || { good: 0, notQuotable: 0, missedCalls: 0, noData: 0 }), noData: parseInt(e.target.value) || 0 } }
                                }))}
                                data-testid="input-other-leads-lq-nodata"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                    );
                  })()}

                  {/* Lead Sources Pie Chart */}
                  {leadSourceBreakdown.total > 0 && (
                    <Card className="bg-card border-primary/10" data-testid="chart-lead-sources">
                      <CardHeader>
                        <CardTitle className="text-foreground">{t("leads")} Sources Breakdown</CardTitle>
                        <CardDescription>Distribution of {t("leads").toLowerCase()} by source</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-8">
                          <div className="w-[270px] h-[240px] overflow-visible" data-testid="chart-pie-container">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie
                                  data={leadSourceBreakdown.sources}
                                  cx="50%"
                                  cy="50%"
                                  innerRadius={40}
                                  outerRadius={65}
                                  paddingAngle={2}
                                  dataKey="value"
                                  label={({ name, percent }) => `${(percent * 100).toFixed(0)}%`}
                                  labelLine={false}
                                >
                                  {leadSourceBreakdown.sources.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                  ))}
                                </Pie>
                                <Tooltip formatter={(value: number, name: string) => {
                                  const entry = leadSourceBreakdown.sources.find(s => s.name === name);
                                  if (entry?.isWebinar) {
                                    return [`${value} ${t("leads").toLowerCase()} equiv.`, ''];
                                  }
                                  return [`${value} ${t("leads").toLowerCase()}`, ''];
                                }} />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                          <div className="flex flex-col gap-2" data-testid="chart-legend">
                            {leadSourceBreakdown.sources.map((source, index) => (
                              <div key={index} className="flex items-center gap-2" data-testid={`row-lead-source-${source.name.toLowerCase().replace(/\s+/g, '-')}`}>
                                <div 
                                  className="w-3 h-3 rounded-full" 
                                  style={{ backgroundColor: source.color }}
                                />
                                <span className="text-sm font-medium">{source.name}:</span>
                                <span className="text-sm" data-testid={`text-leads-${source.name.toLowerCase().replace(/\s+/g, '-')}`}>
                                  {source.value} {t("leads").toLowerCase()}{source.isWebinar ? ' equiv.' : ''} ({((source.value / leadSourceBreakdown.total) * 100).toFixed(1)}%)
                                </span>
                              </div>
                            ))}
                            {hasWebinarProduct && webinarLeadEquiv > 0 && (
                              <div className="text-xs text-muted-foreground mt-2 italic border-t pt-2" data-testid="text-lead-equiv-footnote">
                                * Webinar: {hasWebinarLeadQuality ? webinarLeadCount + ' leads' : (marketingData.webinar.hotTransfers || 0) + ' Hot Transfers'} × 1.6 = {webinarLeadEquiv} lead equiv.
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                </div>
              </TabsContent>

              {/* NEXT 30 DAYS TAB */}
              <TabsContent value="actions">
                <Card className="bg-card border-primary/10">
                  <CardHeader>
                    <CardTitle className="text-foreground">Next 30 Days</CardTitle>
                    <CardDescription>Action items for our team and the client</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <SectionAuditInfo reportId={activeReportId} sectionKey="nextActions" {...getSectionMeta("nextActions")} />
                    {/* Our Actions */}
                    <div>
                      <Label className="text-base font-medium text-foreground">Our Team's Actions</Label>
                      <div className="space-y-3 mt-3">
                        {nextActionsData.ours.map((item, idx) => (
                          <div key={idx} className="p-3 bg-surface-warm-1 rounded-lg">
                            <div className="flex justify-between items-start">
                              <div className="flex-1">
                                <p className="font-medium">{item.action}</p>
                                {item.why && <p className="text-sm text-muted-foreground mt-1">Why: {item.why}</p>}
                                {(item.owner || item.due) && (
                                  <div className="flex items-center flex-wrap gap-2 mt-2">
                                    {item.owner && (
                                      <span className="text-xs font-semibold uppercase text-foreground" data-testid={`our-action-owner-${idx}`}>{item.owner}</span>
                                    )}
                                    {item.due && <span className="text-xs text-muted-foreground" data-testid={`our-action-due-${idx}`}>Due: {item.due}</span>}
                                  </div>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setNextActionsData(prev => ({
                                  ...prev,
                                  ours: prev.ours.filter((_, i) => i !== idx),
                                }))}
                                aria-label="Remove action item"
                              >
                                <Trash2 className="w-4 h-4 text-status-critical" />
                              </Button>
                            </div>
                          </div>
                        ))}
                        <div className="space-y-2 p-3 border border-dashed rounded-lg">
                          <Input
                            placeholder="What we will do..."
                            value={newOurAction.action}
                            onChange={e => setNewOurAction(prev => ({ ...prev, action: e.target.value }))}
                          />
                          <Textarea
                            placeholder="Why this matters..."
                            value={newOurAction.why}
                            onChange={e => setNewOurAction(prev => ({ ...prev, why: e.target.value }))}
                            rows={2}
                          />
                          {/* Task #4282 — optional accountability fields. */}
                          <div className="flex gap-2">
                            <Input
                              className="w-28"
                              placeholder="Owner (JD)"
                              maxLength={NEXT_ACTION_OWNER_MAX_CHARS}
                              value={newOurAction.owner}
                              onChange={e => setNewOurAction(prev => ({ ...prev, owner: e.target.value }))}
                              data-testid="input-our-action-owner"
                            />
                            <Input
                              className="flex-1"
                              placeholder="Due hint (e.g. by Feb 14)"
                              maxLength={NEXT_ACTION_DUE_MAX_CHARS}
                              value={newOurAction.due}
                              onChange={e => setNewOurAction(prev => ({ ...prev, due: e.target.value }))}
                              data-testid="input-our-action-due"
                            />
                          </div>
                          <Button variant="outline" size="sm" onClick={addOurAction} disabled={!newOurAction.action.trim()}>
                            <Plus className="w-4 h-4 mr-1" /> Add Our Action
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* Their Actions */}
                    <div className="border-t pt-6">
                      <Label className="text-base font-medium text-foreground">Client's Actions</Label>
                      <div className="space-y-3 mt-3">
                        {nextActionsData.theirs.map((item, idx) => (
                          <div key={idx} className="p-3 bg-surface-warm-1 rounded-lg">
                            <div className="flex justify-between items-start">
                              <div className="flex-1">
                                <p className="font-medium">{item.action}</p>
                                {item.why && <p className="text-sm text-muted-foreground mt-1">Why: {item.why}</p>}
                                {(item.owner || item.due) && (
                                  <div className="flex items-center flex-wrap gap-2 mt-2">
                                    {item.owner && (
                                      <span className="text-xs font-semibold uppercase text-foreground" data-testid={`their-action-owner-${idx}`}>{item.owner}</span>
                                    )}
                                    {item.due && <span className="text-xs text-muted-foreground" data-testid={`their-action-due-${idx}`}>Due: {item.due}</span>}
                                  </div>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setNextActionsData(prev => ({
                                  ...prev,
                                  theirs: prev.theirs.filter((_, i) => i !== idx),
                                }))}
                                aria-label="Remove action item"
                              >
                                <Trash2 className="w-4 h-4 text-status-critical" />
                              </Button>
                            </div>
                          </div>
                        ))}
                        <div className="space-y-2 p-3 border border-dashed rounded-lg">
                          <Input
                            placeholder="What the client needs to do..."
                            value={newTheirAction.action}
                            onChange={e => setNewTheirAction(prev => ({ ...prev, action: e.target.value }))}
                          />
                          <Textarea
                            placeholder="Why this matters..."
                            value={newTheirAction.why}
                            onChange={e => setNewTheirAction(prev => ({ ...prev, why: e.target.value }))}
                            rows={2}
                          />
                          {/* Task #4282 — optional accountability fields. */}
                          <div className="flex gap-2">
                            <Input
                              className="w-28"
                              placeholder="Owner (initials)"
                              maxLength={NEXT_ACTION_OWNER_MAX_CHARS}
                              value={newTheirAction.owner}
                              onChange={e => setNewTheirAction(prev => ({ ...prev, owner: e.target.value }))}
                              data-testid="input-their-action-owner"
                            />
                            <Input
                              className="flex-1"
                              placeholder="Due hint (e.g. by Feb 14)"
                              maxLength={NEXT_ACTION_DUE_MAX_CHARS}
                              value={newTheirAction.due}
                              onChange={e => setNewTheirAction(prev => ({ ...prev, due: e.target.value }))}
                              data-testid="input-their-action-due"
                            />
                          </div>
                          <Button variant="outline" size="sm" onClick={addTheirAction} disabled={!newTheirAction.action.trim()}>
                            <Plus className="w-4 h-4 mr-1" /> Add Their Action
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="border-t pt-6">
                      <div className="flex items-center justify-between mb-3">
                        <Label className="text-base font-medium text-foreground">Notes</Label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">{nextActionsData.showNotes ? "Visible on report" : "Hidden on report"}</span>
                          <Switch
                            data-testid="toggle-show-notes"
                            checked={nextActionsData.showNotes}
                            onCheckedChange={(checked) => setNextActionsData(prev => ({ ...prev, showNotes: checked }))}
                          />
                        </div>
                      </div>
                      <Textarea
                        data-testid="input-notes"
                        placeholder="Additional notes, context, or reminders for this report..."
                        value={nextActionsData.notes}
                        onChange={e => setNextActionsData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={4}
                        className="bg-surface-warm-1/50"
                      />
                    </div>

                    {/* Task #4282 — expansion band is opt-in: only reports where
                        expansion is genuinely on the table show the "Question
                        We're Always Asking" callout. */}
                    <div className="border-t pt-6">
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-base font-medium">Expansion question</Label>
                          <p className="text-sm text-muted-foreground mt-1">
                            Show "The Question We're Always Asking" (spend more / expand locations) on the report. Turn on only when expansion is genuinely on the table.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">{nextActionsData.showExpansionQuestion ? "Visible on report" : "Hidden on report"}</span>
                          <Switch
                            data-testid="toggle-show-expansion-question"
                            checked={nextActionsData.showExpansionQuestion}
                            onCheckedChange={(checked) => setNextActionsData(prev => ({ ...prev, showExpansionQuestion: checked }))}
                          />
                        </div>
                      </div>
                    </div>

                  </CardContent>
                </Card>
              </TabsContent>

              {/* Task #4273 — per-slide verdict sentences (audit §8.1-1). */}
              <TabsContent value="verdicts">
                <Card className="bg-card border-primary/10">
                  <CardHeader>
                    <CardTitle className="text-foreground">Slide Verdicts</CardTitle>
                    <CardDescription>
                      One plain-language sentence that opens each major slide — what the numbers mean and the move that matters.
                      These are yours to write: nothing is auto-drafted, and a slide you leave blank simply renders without the line.
                      Use “Draft with AI” on a slide if you want a starting point — it only fills the box for you to edit and save.
                      Placeholder junk still blocks finalize.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    <SectionAuditInfo reportId={activeReportId} sectionKey="slideVerdicts" {...getSectionMeta("slideVerdicts")} />
                    {SLIDE_VERDICT_KEYS.map((key) => {
                      const value = verdictsData[key] ?? "";
                      const problem = findDegenerateVerdict(value);
                      return (
                        <div key={key} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <Label htmlFor={`verdict-${key}`} className="text-base font-medium text-foreground">
                              {SLIDE_VERDICT_LABELS[key]}
                            </Label>
                            <div className="flex items-center gap-1.5">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={draftingVerdictKey !== null || !activeReportId}
                                onClick={() => draftVerdict(key)}
                                data-testid={`button-draft-verdict-${key}`}
                              >
                                {draftingVerdictKey === key ? (
                                  <Loader2 className="w-3 h-3 animate-spin mr-1" />
                                ) : (
                                  <Sparkles className="w-3 h-3 mr-1" />
                                )}
                                {value ? "Redraft with AI" : "Draft with AI"}
                              </Button>
                              {value && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => clearVerdict(key)}
                                  data-testid={`button-clear-verdict-${key}`}
                                >
                                  <X className="w-3 h-3 mr-1" /> Clear
                                </Button>
                              )}
                            </div>
                          </div>
                          <Textarea
                            id={`verdict-${key}`}
                            value={value}
                            rows={2}
                            maxLength={500}
                            placeholder='e.g. "Intake is leaking ~$18K/mo — answer speed is the fix."'
                            onChange={(e) => {
                              const next = { ...verdictsDataRef.current, [key]: e.target.value };
                              verdictsDataRef.current = next;
                              setVerdictsData(next);
                            }}
                            onBlur={() => saveVerdictsMap(verdictsDataRef.current)}
                            data-testid={`input-verdict-${key}`}
                          />
                          {problem && (
                            <p className="text-xs text-status-warn" data-testid={`hint-verdict-floor-${key}`}>
                              Below the publish floor — {verdictProblemLabel(problem.reason)}. Finalize will block until this is fixed or cleared.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>

      <Dialog open={inactiveLeadsDialogOpen} onOpenChange={setInactiveLeadsDialogOpen}>
        <DialogContent className="max-w-md" data-testid="dialog-inactive-leads">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-status-warn" />
              Leads from Non-Active Products
            </DialogTitle>
            <DialogDescription>
              This report contains leads from sources that aren't currently active for this client. How would you like to handle them?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {inactiveProductLeadSources.map(source => {
              const leadCount = source === "GBP"
                ? marketingData.gbpLocations.reduce((sum, loc) => sum + (loc.uniqueLeads || 0), 0)
                : source === "Google Ads" ? (marketingData.googleAds.uniqueLeads || 0)
                : source === "LSA" ? (marketingData.lsa.uniqueLeads || 0)
                : source === "Webinar" ? (marketingData.webinar.hotTransfers || 0)
                : 0;
              return (
                <div key={source} className="flex items-center justify-between p-3 bg-status-warn/10 rounded-lg border border-status-warn/40">
                  <div>
                    <span className="font-medium text-sm">{source}</span>
                    <span className="text-xs text-muted-foreground ml-2">({leadCount} leads)</span>
                  </div>
                  <span className="text-xs text-status-warn bg-status-warn/15 px-2 py-0.5 rounded">Currently in "Other"</span>
                </div>
              );
            })}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setInactiveLeadsDialogOpen(false);
                setInactiveLeadsDismissed(true);
              }}
              data-testid="button-keep-in-other"
            >
              Keep in "Other"
            </Button>
            <Button
              onClick={() => {
                const currentProducts: string[] = [...(clientProducts || [])];
                for (const productId of selectedProductsToAdd) {
                  if (!currentProducts.includes(productId)) {
                    currentProducts.push(productId);
                  }
                }
                updateClientProductsMutation.mutate(currentProducts);
              }}
              disabled={updateClientProductsMutation.isPending}
              className="bg-primary hover:bg-primary/90"
              data-testid="button-activate-products"
            >
              {updateClientProductsMutation.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-2" />Updating...</>
              ) : (
                <>Activate {inactiveProductLeadSources.join(" & ")} for this client</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showImportReview} onOpenChange={(open) => {
        if (!open) {
          setShowImportReview(false);
          setPendingImportData(null);
          setWebinarConflictFlagged(false);
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-import-review">
          <DialogHeader>
            <DialogTitle>Review Imported Data</DialogTitle>
            <DialogDescription>
              Fields where the PDF differs from the saved value are highlighted in amber and pre-checked as <strong>Will overwrite</strong>. Uncheck anything you want to keep. Fields with no change are left unchecked by default.
            </DialogDescription>
          </DialogHeader>
          
          {pendingImportData && (() => {
            const sections = ["General", "Marketing", "Intake", "Sales"];
            const currentSnapshot = buildCurrentSnapshot();
            return (
              <div className="space-y-4">
                {sections.map(section => {
                  const fields = importFieldDefinitions.filter(f => f.section === section);
                  // A field is "found" if the parser returned anything for it
                  // (including legitimate 0/"") OR if it differs from current
                  // (covers the 5 -> 0 overwrite case). Otherwise it's reported
                  // as missing in the collapsed group.
                  const fieldsWithValues = fields.filter(f => {
                    // Task #3772 — a numeric metric with NO parse evidence is
                    // a defaulted 0, not a found value: it renders in the
                    // "Not found in PDF" group instead of as a selectable,
                    // fabricated "0" row. (A parsed 0 WITH evidence still
                    // renders normally — that's a real overwrite offer.)
                    if (importMetricNotFound(pendingImportData, f.key)) return false;
                    const parsedVal = getFieldValue(pendingImportData, f.key);
                    if (parsedVal !== undefined) return true;
                    return !valuesEqual(parsedVal, getFieldValue(currentSnapshot, f.key));
                  });
                  const fieldsWithoutValues = fields.filter(f => !fieldsWithValues.includes(f));
                  if (fieldsWithValues.length === 0 && fieldsWithoutValues.length === 0) return null;
                  
                  return (
                    <div key={section} className="space-y-1" data-testid={`import-section-${section.toLowerCase()}`}>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-foreground border-b border-primary/20 pb-1 flex-1">{section}</h3>
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-primary-ink ml-2"
                          onClick={() => {
                            const allChecked = fieldsWithValues.every(f => importFieldSelections[f.key]);
                            const updates: Record<string, boolean> = {};
                            for (const f of fieldsWithValues) {
                              updates[f.key] = !allChecked;
                            }
                            setImportFieldSelections(prev => ({ ...prev, ...updates }));
                          }}
                          data-testid={`toggle-section-${section.toLowerCase()}`}
                        >
                          Toggle All
                        </button>
                      </div>
                      {fieldsWithValues.map(field => {
                        const value = getFieldValue(pendingImportData, field.key);
                        const currentValue = getFieldValue(currentSnapshot, field.key);
                        // Diff visibility is based on direct comparison so that
                        // 5 -> 0, "x" -> "", and 0 -> X all surface as overwrites.
                        // currentDefined: the form has a real saved path (even
                        // if the value is 0/""). undefined means there is no
                        // existing field at all, so we fall back to the simple
                        // single-value "New: X" layout.
                        const currentDefined = currentValue !== undefined;
                        const differs = !valuesEqual(value, currentValue);
                        const conf = getFieldConfidence(pendingImportData, field.key);
                        const confSource = getFieldConfidenceSource(pendingImportData, field.key);
                        const isSelected = importFieldSelections[field.key] ?? false;
                        const confIcon = conf === "high" ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-status-ok flex-shrink-0" />
                        ) : conf === "medium" ? (
                          <AlertCircle className="w-3.5 h-3.5 text-status-warn flex-shrink-0" />
                        ) : (
                          <HelpCircle className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        );
                        const confLabel = conf === "high" ? "High confidence" : conf === "medium" ? "Medium confidence - verify" : "Low confidence";
                        // Task #2852 — reimport flagged that the PDF's webinar
                        // Lead Quality breakdown differs from saved (possibly
                        // hand-corrected) edits. Badge the row inline; it also
                        // starts unchecked so keeping the edits is the default.
                        const isWebinarConflict = field.key === "marketing.webinar" && webinarConflictFlagged;
                        // Task #3868 — badge sub-fields the parser did NOT
                        // find inside an otherwise evidence-backed composite:
                        // applying the row preserves the current form value
                        // for those instead of writing the displayed
                        // parser-defaulted 0 (webinar hotTransfers may be
                        // evidenced via webinar.leads).
                        const preservedSubFields = (COMPOSITE_NUMERIC_SUBFIELDS[field.key] || []).filter((sf) =>
                          (sf === "hotTransfers" ? ["hotTransfers", "leads"] : [sf]).every((k) =>
                            importCompositeSubFieldNotFound(pendingImportData, field.key, k),
                          ),
                        );

                        return (
                          <label
                            key={field.key}
                            className={`flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                              isWebinarConflict && !isSelected
                                ? "border-status-critical/60 bg-status-critical/10"
                                : isSelected
                                ? (currentDefined && differs
                                    ? "border-status-warn/60 bg-status-warn/10"
                                    : "border-primary/30 bg-primary/5")
                                : "border-border bg-muted/50 opacity-60"
                            }`}
                            data-testid={`import-field-${field.key}`}
                          >
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(checked) => {
                                setImportFieldSelections(prev => ({
                                  ...prev,
                                  [field.key]: !!checked,
                                }));
                              }}
                              className="mt-0.5"
                              data-testid={`checkbox-${field.key}`}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {confIcon}
                                <span className="text-sm font-medium text-foreground">{field.label}</span>
                                {isWebinarConflict && (
                                  <span className="text-caption uppercase tracking-wide font-semibold text-status-critical bg-status-critical/15 px-1.5 py-0.5 rounded" data-testid="badge-webinar-conflict">
                                    Differs from your saved edits
                                  </span>
                                )}
                                {currentDefined && differs && !isWebinarConflict && (
                                  <span className="text-caption uppercase tracking-wide font-semibold text-status-warn bg-status-warn/15 px-1.5 py-0.5 rounded" data-testid={`badge-overwrite-${field.key}`}>
                                    Will overwrite
                                  </span>
                                )}
                                {currentDefined && !differs && (
                                  <span className="text-caption uppercase tracking-wide font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded" data-testid={`badge-unchanged-${field.key}`}>
                                    No change
                                  </span>
                                )}
                              </div>
                              {currentDefined && differs ? (
                                <div className="text-sm mt-0.5 space-y-0.5">
                                  <p className="text-muted-foreground truncate" data-testid={`current-value-${field.key}`}>
                                    <span className="text-xs uppercase tracking-wide text-muted-foreground mr-1">Current:</span>
                                    {field.format(currentValue)}
                                  </p>
                                  <p className="text-foreground font-medium truncate" data-testid={`new-value-${field.key}`}>
                                    <span className="text-xs uppercase tracking-wide text-status-warn mr-1">New:</span>
                                    {field.format(value)}
                                  </p>
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground mt-0.5 truncate" data-testid={`new-value-${field.key}`}>{field.format(value)}</p>
                              )}
                              {preservedSubFields.length > 0 && (
                                <p className="text-xs text-status-info mt-0.5" data-testid={`text-preserved-subfields-${field.key}`}>
                                  Not in PDF: {preservedSubFields.join(", ")} — applying keeps the current saved value{preservedSubFields.length > 1 ? "s" : ""} for {preservedSubFields.length > 1 ? "these" : "it"}.
                                </p>
                              )}
                              {isWebinarConflict && (
                                <p className="text-xs text-status-critical mt-0.5" data-testid="text-webinar-conflict-hint">
                                  The PDF's webinar Lead Quality breakdown differs from what's saved (it may include manual corrections). Leave unchecked to keep your edits; check to overwrite with the parsed breakdown.
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-0.5">{confLabel}</p>
                              {conf !== "high" && confSource && (
                                <p className="text-xs text-muted-foreground mt-0.5 italic" data-testid={`confidence-source-${field.key}`}>
                                  {confSource.charAt(0).toUpperCase() + confSource.slice(1)}
                                </p>
                              )}
                            </div>
                          </label>
                        );
                      })}
                      {fieldsWithoutValues.length > 0 && (
                        <div className="pl-2 pt-1">
                          <p className="text-xs text-muted-foreground">
                            Not found in PDF: {fieldsWithoutValues.map(f => f.label).join(", ")}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowImportReview(false);
                setPendingImportData(null);
                setWebinarConflictFlagged(false);
              }}
              data-testid="button-cancel-import"
            >
              Cancel
            </Button>
            <Button
              onClick={applyImportData}
              className="bg-primary hover:bg-primary/90"
              data-testid="button-apply-import"
            >
              Apply Selected Fields ({Object.values(importFieldSelections).filter(Boolean).length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMissingFieldsDialog} onOpenChange={(open) => {
        setShowMissingFieldsDialog(open);
        if (!open && pendingFinalize) {
          setPendingFinalize(false);
          setFunnelConfirmMetrics([]);
          setQualityGateGaps([]);
          setQualityGateThinSections([]);
          setFormData(prev => ({ ...prev, status: existingReport?.status || "draft" }));
        }
      }}>
        <DialogContent className="max-w-md" data-testid="dialog-missing-fields">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-status-warn" />
              Missing Fields
            </DialogTitle>
            <DialogDescription>
              The following fields across the report are still empty or at zero. You can finalize anyway or go back and fill them in.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {/* Task #3769 — explicit confirm for key funnel metrics a
                broken-source import left missing. */}
            {funnelConfirmMetrics.length > 0 && (
              <div className="rounded-md border border-status-critical/40 bg-status-critical/10 p-3" data-testid="callout-broken-source-finalize">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-critical mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-foreground">
                    <span className="font-semibold">Broken-source import:</span>{" "}
                    {funnelConfirmMetrics.join(" and ")} {funnelConfirmMetrics.length > 1 ? "are" : "is"} still
                    missing even though the previous report had {funnelConfirmMetrics.length > 1 ? "them" : "it"} entered.
                    The shared report will show &ldquo;No data&rdquo; for {funnelConfirmMetrics.length > 1 ? "these metrics" : "this metric"}.
                    Finalize only if that is intended.
                  </div>
                </div>
              </div>
            )}
            {/* Task #4227 — explicit confirm for report-quality gaps the
                server-side finalize gate named (degenerate Common Issues
                copy / empty Next 30 Days columns). */}
            {qualityGateGaps.length > 0 && (
              <div className="rounded-md border border-status-critical/40 bg-status-critical/10 p-3" data-testid="callout-quality-gate-finalize">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-status-critical mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-foreground">
                    <span className="font-semibold">Report quality:</span>
                    <ul className="list-disc ml-4 mt-1 space-y-1">
                      {qualityGateGaps.map((gap, i) => (
                        <li key={i}>{gap}</li>
                      ))}
                    </ul>
                    Finalize only if this is intended — the client will see it.
                  </div>
                </div>
                {/* Task #4254 — curated copy-library picker for each thin
                    section. Operator explicitly selects blocks; nothing is
                    ever auto-applied. */}
                {qualityGateThinSections.map((section) => {
                  const label = section === "intake" ? "Intake" : "Sales";
                  const blocks = getCuratedIssueBlocks(section);
                  const selectedCount = blocks.filter((b) => curatedSelections[b.id]).length;
                  return (
                    <div
                      key={section}
                      className="mt-3 rounded-md border border-border bg-card p-3"
                      data-testid={`curated-copy-picker-${section}`}
                    >
                      <div className="text-sm font-semibold text-foreground mb-1">
                        Replace {label} Common Issues with curated copy
                      </div>
                      <p className="text-xs text-muted-foreground mb-2">
                        Pick only issues that genuinely apply to this client — the selected blocks replace the current {label} Common Issues text.
                      </p>
                      <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                        {blocks.map((b) => (
                          <label
                            key={b.id}
                            className="flex items-start gap-2 cursor-pointer"
                            data-testid={`curated-copy-option-${b.id}`}
                          >
                            <Checkbox
                              checked={!!curatedSelections[b.id]}
                              onCheckedChange={(checked) =>
                                setCuratedSelections((prev) => ({ ...prev, [b.id]: checked === true }))
                              }
                              className="mt-0.5"
                            />
                            <span className="text-xs text-foreground">
                              <span className="font-medium">{b.title}</span>
                              <span className="text-muted-foreground"> — {b.issue}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        className="mt-2 bg-primary hover:bg-primary/90"
                        disabled={selectedCount === 0 || saveSectionMutation.isPending}
                        onClick={() => applyCuratedCopy(section)}
                        data-testid={`button-apply-curated-copy-${section}`}
                      >
                        Replace {label} copy ({selectedCount} selected)
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {missingFields.map(group => (
              <div key={group.section}>
                <h4 className="text-sm font-semibold text-foreground mb-1">{group.section}</h4>
                <ul className="space-y-0.5">
                  {group.fields.map(field => (
                    <li key={field} className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-warn flex-shrink-0" />
                      {field}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPendingFinalize(false);
                setFunnelConfirmMetrics([]);
                setQualityGateGaps([]);
                setQualityGateThinSections([]);
                setShowMissingFieldsDialog(false);
                proceedWithFinalize();
              }}
              data-testid="button-finalize-anyway"
            >
              Finalize Anyway
            </Button>
            <Button
              onClick={() => {
                setShowMissingFieldsDialog(false);
                setPendingFinalize(false);
                setFunnelConfirmMetrics([]);
                setQualityGateGaps([]);
                setQualityGateThinSections([]);
                setFormData(prev => ({ ...prev, status: existingReport?.status || "draft" }));
                const firstMissing = missingFields[0];
                if (firstMissing) {
                  const tabMap: Record<string, string> = { Intake: "intake", Sales: "sales", Marketing: "marketing", Actions: "actions" };
                  const tab = tabMap[firstMissing.section];
                  if (tab) setActiveTab(tab);
                }
              }}
              className="bg-primary hover:bg-primary/90"
              data-testid="button-go-fill-fields"
            >
              Go fill them in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <HeatmapPicker
        open={heatmapPickerOpen}
        onClose={() => setHeatmapPickerOpen(false)}
        locationName={heatmapPickerLocationName}
        reportMonth={formData.reportMonth}
        clientId={formData.clientId}
        locationId={heatmapPickerLocationId}
        onSelect={(snapshotIds) => {
          setMarketingData(prev => {
            const updated = [...prev.gbpLocations];
            updated[heatmapPickerLocationIdx] = {
              ...updated[heatmapPickerLocationIdx],
              heatmapSnapshotIds: snapshotIds,
              heatmapSnapshotId: snapshotIds[0],
              heatmapImageUrl: undefined,
            };
            return { ...prev, gbpLocations: updated };
          });
          setPendingHeatmapSave({ idx: heatmapPickerLocationIdx, url: snapshotIds[0] });
        }}
      />

      <Dialog open={showReviewGateDialog} onOpenChange={setShowReviewGateDialog}>
        <DialogContent className="max-w-md" data-testid="dialog-review-gate">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-status-warn" />
              Monthly Review Required
            </DialogTitle>
            <DialogDescription>
              This report cannot be finalized because the client's command panel hasn't been reviewed this month.
              Please review and confirm the command panel first, then return here to finalize.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowReviewGateDialog(false)}
              data-testid="button-review-gate-dismiss"
            >
              Dismiss
            </Button>
            {reviewGateClientId && (
              <Button
                className="bg-primary hover:bg-primary/90"
                onClick={() => {
                  setShowReviewGateDialog(false);
                  navigate(`/clients/${reviewGateClientId}`);
                }}
                data-testid="button-go-to-command-panel"
              >
                Go to Command Panel
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
