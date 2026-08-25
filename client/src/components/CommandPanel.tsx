import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { motionSafeScrollBehavior } from "@/lib/scrollBehavior";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { normalizeProductList } from "@shared/productResolution";
import { useDeferredEnabled } from "@/hooks/use-deferred-enabled";
import { CLIENT_HEAVY_QUERY_STALE_TIME_MS, primaryQuerySemaphore, deferredQuerySemaphore, throttledFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import {
  Pencil, X, Check, Clock, AlertTriangle, History, ExternalLink,
  ChevronUp, ChevronDown, Plus, Trash2, Shield, Target, MapPin,
  Zap, Link2, Package, GripVertical, CheckCircle, DollarSign,
  Lightbulb, Save, Phone, Video, FileText, Sparkles, Search, Unlink, Eye, Loader2,
  Mail, Users, Star, Building2, Calendar, Download, RotateCw, FolderOpen
} from "lucide-react";
import { format } from "date-fns";
import { terminologyDefaults, terminologyKeys, type ClientTerminology, type TerminologyKey, dataAccessCategoryDefs, type DataAccessDetectionMap } from "@shared/schema";
import ChangelogViewer from "./ChangelogViewer";
import { PhoneHubIconActions } from "@/components/ClientCommsQuickActions";
import { ContactAuditInfo, type ContactAuditSummary } from "@/components/ContactAuditInfo";
import { LocationAuditInfo, type LocationAuditSummary } from "@/components/LocationAuditInfo";
import { CommandPanelSectionAuditInfo, type CommandPanelHistoryEntry } from "@/components/CommandPanelSectionAuditInfo";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
// Task #3836 — pdfjs-dist (~900 KB) must only download on first PDF view,
// never with the client-detail chunk. lazyWithRetry keeps stale-deploy
// chunk-retry behavior identical to lazy pages.
const PdfPreviewWithSearch = lazyWithRetry(() => import("./PdfPreviewWithSearch"));
import { logActivity } from "@/hooks/use-activity-tracker";
import { reviewReasonLabel } from "@/lib/matchMethod";

type ExternalSystemLink = {
  label: string;
  url: string;
};

type CommandPanelData = {
  id: string;
  clientId: string;
  accountOwnerId: string | null;
  secondaryOwnerIds: string[] | null;
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  productTypes: string[] | null;
  productStatusNotes: string | null;
  googleAdsBudget: number | null;
  webinarBudget: number | null;
  lsaBudget: number | null;
  annualRevenueGoal: number | null;
  onboardingNotes: string | null;
  quarterPrimaryObjective: string | null;
  annualGoals: string | null;
  longTermGoals: string | null;
  successDefinitionQuarter: string | null;
  growthStrategy: string | null;
  currentBottleneck: string | null;
  budgetPosture: string | null;
  approvedTerritory: string | null;
  priorityMarkets: any;
  secondaryMarkets: any;
  geographicExpansionNotes: string | null;
  googleAdsTargetAreas: string[] | null;
  googleAdsTargetingMethod: string | null;
  googleAdsExcludedAreas: string | null;
  googleAdsGeoNotes: string | null;
  webinarTargetAreas: string[] | null;
  webinarGeoNotes: string | null;
  activeCampaignFocus: string | null;
  activeOffers: string | null;
  keyActiveInitiatives: string | null;
  currentRiskFlags: string | null;
  currentOpportunities: string | null;
  clientPreferences: string | null;
  internalHandlingNotes: string | null;
  googleDriveFolderLink: string | null;
  googleDriveFolderName: string | null;
  zoomRecordingsFolderId: string | null;
  zoomRecordingsFolderLink: string | null;
  zoomRecordingsFolderName: string | null;
  rerReportsFolderId: string | null;
  rerReportsFolderLink: string | null;
  rerReportsFolderName: string | null;
  externalSystemLinks: ExternalSystemLink[] | null;
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
  createdAt: string | null;
};

type HistoryEntry = {
  id: string;
  commandPanelId: string;
  clientId: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  reason: string | null;
  createdAt: string;
};

type KeyCallEntry = {
  id: string;
  commandPanelId: string;
  clientId: string;
  callType: string;
  rawCommunicationRecordId: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  communication: {
    id: string;
    title: string;
    timestamp: string;
    sourceType: string;
    contentText: string | null;
    aiSummary: string | null;
    contentPreview: string | null;
  } | null;
};

type RerEntry = {
  id: string;
  commandPanelId: string;
  clientId: string;
  rawCommunicationRecordId: string;
  reportingMonth: string;
  assignedBy: string | null;
  assignedAt: string | null;
  communication: {
    id: string;
    title: string;
    timestamp: string;
    sourceType: string;
    contentText: string | null;
    aiSummary: string | null;
    contentPreview: string | null;
  } | null;
};

type ClientContact = {
  id: string;
  clientId: string;
  name: string;
  emails: string[] | null;
  phones: string[] | null;
  roleTitle: string | null;
  isPrimary: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type ContactFormData = {
  name: string;
  emails: string[];
  phones: string[];
  roleTitle: string;
  isPrimary: boolean;
};

type CommRecord = {
  id: string;
  title: string;
  timestamp: string;
  sourceType: string;
  decisionId?: string | null;
  reviewReason?: string | null;
  suggestedClientId?: string | null;
  suggestedClientName?: string | null;
  suggestedConfidence?: number | null;
  priorClientId?: string | null;
  priorClientName?: string | null;
  isPendingReview?: boolean;
};

function UnmatchedZoomOptionLabel({ c }: { c: CommRecord }) {
  const pending = !!c.isPendingReview;
  const pct = c.suggestedConfidence != null ? Math.round(c.suggestedConfidence * 100) : null;
  const reviewQueueHref = c.decisionId
    ? `/admin/zoom/review?focus=${encodeURIComponent(c.decisionId)}`
    : null;
  return (
    <span
      className="flex flex-col gap-0.5"
      data-testid={`label-unmatched-zoom-${c.id}`}
    >
      <span className="flex items-center gap-1.5">
        <span className="truncate">{c.title}</span>
        {pending ? (
          <>
            <Badge
              className="h-4 px-1.5 text-caption bg-yellow-100 text-yellow-800 border border-yellow-200"
              data-testid={`badge-pending-review-${c.id}`}
            >
              <Clock className="w-2.5 h-2.5 mr-0.5" />
              Pending review
            </Badge>
            {reviewQueueHref && (
              <a
                href={reviewQueueHref}
                target="_blank"
                rel="noreferrer"
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-caption text-primary-ink hover:text-primary-ink/80 hover:underline"
                title="View in agent review queue"
                data-testid={`link-review-queue-${c.id}`}
              >
                View in review queue
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
          </>
        ) : (
          <span className="text-muted-foreground/70 text-caption">(unassigned — will be linked)</span>
        )}
      </span>
      {pending && (
        <span className="text-caption text-muted-foreground/70" data-testid={`text-pending-detail-${c.id}`}>
          {c.reviewReason ? reviewReasonLabel(c.reviewReason) : "Review required"}
          {c.suggestedClientName ? ` · suggested ${c.suggestedClientName}${pct != null ? ` (${pct}%)` : ""}` : ""}
          {c.priorClientName ? ` · was ${c.priorClientName}` : ""}
        </span>
      )}
    </span>
  );
}

type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

type Client = {
  id: string;
  firmName: string;
  ownerId: string | null;
  practiceAreas: string[] | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  consultType?: string | null;
  clientStartDate?: string | null;
  terminology?: ClientTerminology;
};

type DataAccessEntry = {
  category: string;
  status: string;
};

// Task #2418 — labels + "what this unlocks" descriptions come from the
// single shared source of truth so the Command Panel and the report never
// diverge again.
const DATA_ACCESS_CATEGORIES = dataAccessCategoryDefs.map(d => ({
  id: d.id,
  label: d.label,
  description: d.unlocks,
}));

type GbpLocation = {
  id: number;
  clientId: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
};

const PRODUCT_OPTIONS = [
  { id: "gbp", label: "GBP" },
  { id: "google_ads", label: "Google Ads" },
  { id: "lsa", label: "LSA" },
  { id: "webinar", label: "Webinars" },
];

const BOTTLENECK_OPTIONS = [
  { id: "intake_capacity", label: "Intake Capacity" },
  { id: "sales_conversion", label: "Sales Conversion" },
  { id: "lead_volume", label: "Lead Volume" },
  { id: "budget_constraints", label: "Budget Constraints" },
  { id: "staffing", label: "Staffing" },
  { id: "market_saturation", label: "Market Saturation" },
  { id: "tracking_gaps", label: "Tracking Gaps" },
  { id: "creative_fatigue", label: "Creative Fatigue" },
  { id: "other", label: "Other" },
];

const BUDGET_POSTURE_OPTIONS = [
  { id: "aggressive", label: "Aggressive" },
  { id: "moderate", label: "Moderate" },
  { id: "conservative", label: "Conservative" },
  { id: "scaling_back", label: "Scaling Back" },
  { id: "paused", label: "Paused" },
];

const FIELD_LABELS: Record<string, string> = {
  accountOwnerId: "Account Owner",
  secondaryOwnerIds: "Secondary Owners",
  productTypes: "Products",
  productStatusNotes: "Product Status Notes",
  googleAdsBudget: "Google Ads Budget",
  webinarBudget: "Webinar Budget",
  lsaBudget: "LSA Budget",
  annualRevenueGoal: "Annual Revenue Goal",
  quarterPrimaryObjective: "Current Quarter Objective(s)",
  onboardingNotes: "Onboarding Notes",
  annualGoals: "Annual Goals",
  longTermGoals: "Long-Term Goals",
  successDefinitionQuarter: "Success Definition",
  growthStrategy: "Growth Strategy",
  currentBottleneck: "Current Bottleneck",
  budgetPosture: "Budget Posture",
  approvedTerritory: "Approved Territory",
  priorityMarkets: "Priority Markets",
  secondaryMarkets: "Secondary Markets",
  geographicExpansionNotes: "Geographic Expansion Notes",
  googleAdsTargetAreas: "Google Ads Target Areas",
  googleAdsTargetingMethod: "Google Ads Targeting Method",
  googleAdsExcludedAreas: "Google Ads Excluded Areas",
  googleAdsGeoNotes: "Google Ads Geo Notes",
  webinarTargetAreas: "Webinar Target Areas",
  webinarGeoNotes: "Webinar Geo Notes",
  activeCampaignFocus: "Campaign Focus",
  activeOffers: "Active Offers",
  keyActiveInitiatives: "Key Initiatives",
  currentRiskFlags: "Risk Flags",
  currentOpportunities: "Opportunities",
  clientPreferences: "Client Preferences",
  internalHandlingNotes: "Internal Handling Notes",
  googleDriveFolderLink: "Google Drive",
  googleDriveFolderName: "Google Drive Folder Name",
  zoomRecordingsFolderId: "Zoom Recordings Folder",
  zoomRecordingsFolderLink: "Zoom Recordings Folder Link",
  zoomRecordingsFolderName: "Zoom Recordings Folder Name",
  rerReportsFolderId: "RER Reports Folder",
  rerReportsFolderLink: "RER Reports Folder Link",
  rerReportsFolderName: "RER Reports Folder Name",
  externalSystemLinks: "External System Links",
};

function isReviewedThisMonth(lastReviewedAt: string | null): boolean {
  if (!lastReviewedAt) return false;
  const reviewed = new Date(lastReviewedAt);
  if (isNaN(reviewed.getTime())) return false;
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  return reviewed >= monthStart;
}

function ReviewBadge({ lastReviewedAt }: { lastReviewedAt: string | null }) {
  if (!lastReviewedAt) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">
        <Clock className="w-3 h-3" />
        Never reviewed
      </span>
    );
  }

  const reviewedThisMonth = isReviewedThisMonth(lastReviewedAt);
  if (reviewedThisMonth) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <CheckCircle className="w-3 h-3" />
        Reviewed {format(new Date(lastReviewedAt), "MMM d")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-700">
      <AlertTriangle className="w-3 h-3" />
      Monthly review due
    </span>
  );
}

interface CommandPanelProps {
  clientId: string;
  client: Client;
  currentUser: User;
  allUsers: User[];
  highlightField?: string | null;
  prefillData?: Record<string, string> | null;
  onEditClient?: () => void;
  onUpdateClient?: (data: { terminology: ClientTerminology }) => void;
  primaryReady?: boolean;
}

export default function CommandPanel({ clientId, client, currentUser, allUsers, highlightField, prefillData, onEditClient, onUpdateClient, primaryReady = false }: CommandPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editData, setEditData] = useState<Record<string, any>>({});
  const [saveReason, setSaveReason] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  // Task #999: when a per-section "Last edited by …" badge is clicked we
  // open the ChangelogViewer pre-filtered to that section's fields. Null
  // means "show everything" (the global "View what changed" button).
  const [historySectionFields, setHistorySectionFields] = useState<string[] | null>(null);
  const [newMarketInput, setNewMarketInput] = useState("");
  const [newSecondaryMarketInput, setNewSecondaryMarketInput] = useState("");
  const [contractPickerOpen, setContractPickerOpen] = useState(false);
  const [contractDetailOpen, setContractDetailOpen] = useState<string | null>(null);
  const [contractPdfDownloading, setContractPdfDownloading] = useState(false);
  const [contractPdfError, setContractPdfError] = useState<string | null>(null);
  const [contractPdfPreviewUrl, setContractPdfPreviewUrl] = useState<string | null>(null);
  const [contractPdfPreviewLoading, setContractPdfPreviewLoading] = useState(false);
  const [contractPdfPreviewError, setContractPdfPreviewError] = useState<string | null>(null);
  const [contractPdfPreviewNotReady, setContractPdfPreviewNotReady] = useState(false);
  const [contractPdfPreviewDisconnected, setContractPdfPreviewDisconnected] = useState(false);
  const [contractSearch, setContractSearch] = useState("");
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactFormData, setContactFormData] = useState<ContactFormData>({ name: "", emails: [""], phones: [""], roleTitle: "", isPrimary: false });

  const canEdit = currentUser.role === "ceo" || currentUser.role === "team_lead" || currentUser.role === "admin" ||
    currentUser.role === "account_manager";
  const isReadOnly = currentUser.role === "sales";

  const { data: clientComms, isSuccess: commsReady } = useQuery<CommRecord[]>({
    queryKey: ["/api/clients", clientId, "communications", "zoom"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/communications?sourceType=zoom`, { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch communications");
      return res.json();
    },
  });

  const { data: unmatchedZoomComms } = useQuery<CommRecord[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "unmatched-zoom"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/command-panel/unmatched-zoom`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: canEdit,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const { data: clientContacts, isLoading: contactsLoading, isSuccess: contactsReady } = useQuery<ClientContact[]>({
    queryKey: ["/api/clients", clientId, "contacts"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/contacts`, { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Task #991: latest audit row per contact, fetched alongside the
  // contacts list. Keyed under the existing ["/api/clients", clientId,
  // "contacts", "audit"] tuple so we can invalidate it together.
  const { data: contactAuditRows = [] } = useQuery<ContactAuditSummary[]>({
    queryKey: ["/api/clients", clientId, "contacts", "audit"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/clients/${clientId}/contacts/audit`, { credentials: "include", signal });
      if (!res.ok) return [];
      return res.json();
    },
  });
  const contactAuditByContact = new Map<string, ContactAuditSummary>(
    contactAuditRows.map((r) => [r.contactId, r]),
  );

  // Task #999: latest audit row per location, fetched alongside the
  // locations list so we can render "Last edited by X · 2h ago" beside
  // every GBP location row without N+1 queries.
  const { data: locationAuditRows = [] } = useQuery<LocationAuditSummary[]>({
    queryKey: ["/api/clients", clientId, "locations", "audit"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/clients/${clientId}/locations/audit`, { credentials: "include", signal });
      if (!res.ok) return [];
      return res.json();
    },
  });
  const locationAuditByLocation = new Map<string, LocationAuditSummary>(
    locationAuditRows.map((r) => [r.locationId, r]),
  );

  // Task #999: full Command Panel history shared by every per-section
  // "Last edited by X · 2h ago" affordance. We fetch once and let each
  // section filter to its own fields, instead of one query per section.
  const { data: commandPanelHistoryEntries = [] } = useQuery<CommandPanelHistoryEntry[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "history"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/history`, { credentials: "include", signal });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const createContactMutation = useMutation({
    mutationFn: async (data: Omit<ContactFormData, "isPrimary"> & { isPrimary: boolean }) => {
      const res = await fetch(`/api/clients/${clientId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...data,
          emails: data.emails.filter(e => e.trim()),
          phones: data.phones.filter(p => p.trim()),
        }),
      });
      if (!res.ok) throw new Error("Failed to create contact");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts", "audit"] }); // fire-and-forget: cache refresh only
      logActivity("save", "Added client contact", { clientId });
      toast({ title: "Contact added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add contact", description: err.message, variant: "destructive" });
    },
  });

  const updateContactMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<ContactFormData> }) => {
      const body = {
        ...data,
        emails: data.emails?.filter(e => e.trim()),
        phones: data.phones?.filter(p => p.trim()),
      };
      const res = await fetch(`/api/clients/${clientId}/contacts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update contact");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts", "audit"] }); // fire-and-forget: cache refresh only
      setEditingContactId(null);
      logActivity("save", "Updated client contact", { clientId });
      toast({ title: "Contact updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update contact", description: err.message, variant: "destructive" });
    },
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/contacts/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete contact");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts", "audit"] }); // fire-and-forget: cache refresh only
      toast({ title: "Contact removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove contact", description: err.message, variant: "destructive" });
    },
  });

  // Task #970: Pending Front contact suggestions for this client. The
  // Front sync routes new participant emails into `import_entity_suggestions`
  // (surface=front_enrichment) instead of silently extending the primary
  // contact. We surface them here so an operator can promote or dismiss
  // each candidate; promote calls the same `promoteEmailsToClientContact`
  // (explicitOptIn:true) helper used by the manual-match dialog.
  type FrontSuggestion = {
    id: string;
    clientId: string;
    entityKind: string;
    surface: string;
    candidate: { name?: string; emails?: string[]; phones?: string[] } | null;
    sourceRef: {
      conversationId?: string;
      messageId?: string;
      subject?: string;
      snippet?: string;
      participants?: Array<{ name?: string; email?: string; role?: string }>;
      capturedAt?: string;
    } | null;
    reason: string | null;
    status: string;
    createdAt: string | null;
  };
  const { data: contactSuggestions = [], isLoading: contactSuggestionsLoading } =
    useQuery<FrontSuggestion[]>({
      queryKey: ["/api/import-suggestions", { clientId, surface: "front_enrichment" }],
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams({
          clientId,
          surface: "front_enrichment",
          status: "pending",
        });
        const res = await fetch(`/api/import-suggestions?${params.toString()}`, {
          credentials: "include",
          signal,
        });
        if (!res.ok) return [];
        const body = await res.json().catch(() => ({}));
        return Array.isArray(body?.items) ? body.items : [];
      },
      enabled: canEdit,
    });

  const invalidateContactSuggestions = () => {
    void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
      queryKey: ["/api/import-suggestions", { clientId, surface: "front_enrichment" }],
    });
  };

  type PromoteSuggestionResponse = {
    suggestion?: { id: string; status: string };
    promotion?: { added?: number; skipped?: number; contactId?: string | null; createdNewContact?: boolean; reason?: string };
  };
  const promoteContactSuggestionMutation = useMutation({
    mutationFn: async (args: { id: string; emails: string[]; contactName?: string }): Promise<PromoteSuggestionResponse> => {
      const res = await fetch(`/api/import-suggestions/${args.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          emails: args.emails,
          ...(args.contactName ? { contactName: args.contactName } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Promotion failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      invalidateContactSuggestions();
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "contacts", "audit"] }); // fire-and-forget: cache refresh only
      const added = data?.promotion?.added ?? 0;
      toast({
        title: added > 0 ? `Added ${added} email${added === 1 ? "" : "s"} to contact` : "Suggestion promoted",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Promotion failed", description: err.message, variant: "destructive" });
    },
  });

  const dismissContactSuggestionMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/import-suggestions/${id}/dismiss`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Dismiss failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      invalidateContactSuggestions();
      toast({ title: "Suggestion dismissed" });
    },
    onError: (err: Error) => {
      toast({ title: "Dismiss failed", description: err.message, variant: "destructive" });
    },
  });

  // Per-suggestion email checkbox selection. Default: all candidate emails
  // checked, so a one-click promote keeps every candidate. Operators can
  // uncheck individual rows to drop noise (vendor reply, opposing counsel)
  // before promoting.
  const [suggestionEmailSelection, setSuggestionEmailSelection] =
    useState<Record<string, Record<string, boolean>>>({});

  const toggleSuggestionEmail = (suggestionId: string, email: string, checked: boolean) => {
    setSuggestionEmailSelection((prev) => ({
      ...prev,
      [suggestionId]: { ...(prev[suggestionId] ?? {}), [email]: checked },
    }));
  };

  const [showGbpLocationForm, setShowGbpLocationForm] = useState(false);
  const [gbpLocationForm, setGbpLocationForm] = useState({ name: "", address: "" });
  const [editingGbpLocationId, setEditingGbpLocationId] = useState<number | null>(null);
  const [gbpLocationError, setGbpLocationError] = useState("");

  const { data: gbpLocations, isSuccess: locationsReady } = useQuery<GbpLocation[]>({
    queryKey: ["/api/clients", clientId, "locations"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/locations`, { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
  });

  const allPrimaryReady = primaryReady && contactsReady && locationsReady && commsReady;
  const deferredStep0 = useDeferredEnabled(allPrimaryReady, 0);
  const deferredStep1 = useDeferredEnabled(allPrimaryReady, 1);
  const deferredStep2 = useDeferredEnabled(allPrimaryReady, 2);

  const { data: panel, isLoading, isError, error } = useQuery<CommandPanelData | null>({
    queryKey: ["/api/clients", clientId, "command-panel"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/command-panel`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (res.status === 403) throw new Error("You do not have access to this client's command panel");
      if (!res.ok) throw new Error("Failed to fetch command panel");
      return res.json();
    },
    enabled: deferredStep0,
    retry: (failureCount, error) => {
      if (error?.message?.includes("do not have access")) return false;
      return failureCount < 3;
    },
    placeholderData: keepPreviousData,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const { data: keyCalls } = useQuery<KeyCallEntry[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "key-calls"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/command-panel/key-calls`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch key calls");
      return res.json();
    },
    enabled: !!panel && deferredStep1,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const { data: rerRecordings } = useQuery<RerEntry[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/command-panel/rer-recordings`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch RER recordings");
      return res.json();
    },
    enabled: !!panel && deferredStep1,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const createGbpLocationMutation = useMutation({
    mutationFn: async (data: { name: string; address: string }) => {
      const res = await fetch(`/api/clients/${clientId}/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to create location" }));
        throw new Error(err.error || err.message || "Failed to create location");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      setShowGbpLocationForm(false);
      setGbpLocationForm({ name: "", address: "" });
      setGbpLocationError("");
      toast({ title: "Location added" });
    },
    onError: (err: Error) => {
      setGbpLocationError(err.message);
    },
  });

  const updateGbpLocationMutation = useMutation({
    mutationFn: async ({ locationId, data }: { locationId: number; data: { name: string; address: string } }) => {
      const res = await fetch(`/api/clients/${clientId}/locations/${locationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to update location" }));
        throw new Error(err.error || err.message || "Failed to update location");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      setEditingGbpLocationId(null);
      setGbpLocationForm({ name: "", address: "" });
      setGbpLocationError("");
      toast({ title: "Location updated" });
    },
    onError: (err: Error) => {
      setGbpLocationError(err.message);
    },
  });

  const deleteGbpLocationMutation = useMutation({
    mutationFn: async (locationId: number) => {
      const res = await fetch(`/api/clients/${clientId}/locations/${locationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete location");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "locations", "audit"] }); // fire-and-forget: cache refresh only
      toast({ title: "Location deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete location", description: err.message, variant: "destructive" });
    },
  });

  const { data: dataAccess } = useQuery<DataAccessEntry[]>({
    queryKey: ["/api/clients", clientId, "data-access"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/data-access`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch data access");
      return res.json();
    },
    enabled: deferredStep1,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  // Task #2418 — advisory data-presence detection so the card can show a
  // small "data detected" hint where the stored flag isn't yet "available".
  const { data: dataAccessDetection } = useQuery<DataAccessDetectionMap>({
    queryKey: ["/api/clients", clientId, "data-access", "detection"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/data-access/detection`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch data access detection");
      return res.json();
    },
    enabled: deferredStep1,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const updateDataAccessMutation = useMutation({
    mutationFn: async ({ category, status }: { category: string; status: string }) => {
      const res = await fetch(`/api/clients/${clientId}/data-access/${category}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update data access");
      return res.json();
    },
    onSuccess: (_data, variables) => {
      // Task #2418 follow-up — authoritatively write the new status into the
      // cache so the read-only view reflects it immediately. The data-access
      // query carries a 60s staleTime behind a deferred/throttled fetch, so
      // relying on the invalidate-triggered refetch alone left the value
      // briefly showing its pre-save state ("reverts automatically"). The
      // invalidate below still reconciles against server truth.
      queryClient.setQueryData<DataAccessEntry[]>(
        ["/api/clients", clientId, "data-access"],
        (old) => {
          const list = old ? [...old] : [];
          const idx = list.findIndex((d) => d.category === variables.category);
          if (idx >= 0) {
            list[idx] = { ...list[idx], status: variables.status };
          } else {
            list.push({ category: variables.category, status: variables.status } as DataAccessEntry);
          }
          return list;
        },
      );
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "data-access"] }); // fire-and-forget: cache refresh only
      toast({ title: "Data access updated" });
    },
    onError: () => {
      toast({ title: "Failed to update data access", variant: "destructive" });
    },
  });

  const [dataAccessDraft, setDataAccessDraft] = useState<Record<string, string>>({});

  const [keyCallAssigning, setKeyCallAssigning] = useState<string | null>(null);
  const [keyCallSelectedComm, setKeyCallSelectedComm] = useState("");
  const [keyCallDetailOpen, setKeyCallDetailOpen] = useState<KeyCallEntry | null>(null);
  const [rerExpanded, setRerExpanded] = useState(false);
  const [rerAssigning, setRerAssigning] = useState(false);
  const [rerSelectedComm, setRerSelectedComm] = useState("");
  const [rerSelectedMonth, setRerSelectedMonth] = useState("");
  const [rerDetailOpen, setRerDetailOpen] = useState<RerEntry | null>(null);

  type ApiErrorBody = { error?: string | Array<{ message?: string }> };
  async function parseError(res: Response, fallback: string): Promise<string> {
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (typeof body?.error === "string") return body.error;
      if (Array.isArray(body?.error)) {
        return body.error.map((i) => i.message).filter((m): m is string => !!m).join("; ") || fallback;
      }
      return fallback;
    } catch {
      return fallback;
    }
  }
  type AssignRerResponse = RerEntry & { duplicate?: boolean };

  const undoClaim = async (recordId: string) => {
    const res = await fetch(`/api/integrations/unmatched/undo-claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ recordId }),
    });
    if (!res.ok) throw new Error(await parseError(res, "Failed to undo claim"));
    return res.json();
  };

  const showClaimUndoToast = (recordId: string, claimLabel: string) => {
    const handle = toast({
      title: claimLabel,
      description: "You have a few seconds to undo this claim.",
      duration: 5000,
      action: (
        <ToastAction
          altText="Undo claim"
          data-testid={`button-undo-claim-toast-${recordId}`}
          onClick={() => {
            handle.dismiss();
            undoClaim(recordId)
              .then(() => {
                void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "key-calls"] }); // fire-and-forget: cache refresh only
                void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"] }); // fire-and-forget: cache refresh only
                void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "unmatched-zoom"] }); // fire-and-forget: cache refresh only
                void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications", "zoom"] }); // fire-and-forget: cache refresh only
                void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"] }); // fire-and-forget: cache refresh only
                toast({ title: "Claim undone", description: "Recording returned to unmatched feed." });
              })
              .catch((err: Error) => {
                toast({ title: "Undo failed", description: err.message, variant: "destructive" });
              });
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  };

  const assignKeyCallMutation = useMutation({
    mutationFn: async ({ callType, rawCommunicationRecordId }: { callType: string; rawCommunicationRecordId: string }) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/key-calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ callType, rawCommunicationRecordId }),
      });
      if (!res.ok) throw new Error(await parseError(res, "Failed to assign key call"));
      return res.json();
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "key-calls"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "unmatched-zoom"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications", "zoom"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"] }); // fire-and-forget: cache refresh only
      showClaimUndoToast(variables.rawCommunicationRecordId, "Key call assigned");
      setKeyCallAssigning(null);
      setKeyCallSelectedComm("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to assign key call", description: err.message, variant: "destructive" });
    },
  });

  const removeKeyCallMutation = useMutation({
    mutationFn: async (callType: string) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/key-calls/${callType}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await parseError(res, "Failed to remove key call"));
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "key-calls"] }); // fire-and-forget: cache refresh only
      toast({ title: "Key call removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove key call", description: err.message, variant: "destructive" });
    },
  });

  const assignRerMutation = useMutation<AssignRerResponse, Error, { rawCommunicationRecordId: string; reportingMonth: string }>({
    mutationFn: async ({ rawCommunicationRecordId, reportingMonth }) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/rer-recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rawCommunicationRecordId, reportingMonth }),
      });
      if (!res.ok) throw new Error(await parseError(res, "Failed to add RER recording"));
      return (await res.json()) as AssignRerResponse;
    },
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "unmatched-zoom"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "communications", "zoom"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/unmatched-feed"] }); // fire-and-forget: cache refresh only
      if (data.duplicate) {
        toast({ title: "RER recording already assigned" });
      } else {
        showClaimUndoToast(variables.rawCommunicationRecordId, "RER recording added");
      }
      setRerAssigning(false);
      setRerSelectedComm("");
      setRerSelectedMonth("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add RER recording", description: err.message, variant: "destructive" });
    },
  });

  const removeRerMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/rer-recordings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await parseError(res, "Failed to remove RER recording"));
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"] }); // fire-and-forget: cache refresh only
      toast({ title: "RER recording removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove RER recording", description: err.message, variant: "destructive" });
    },
  });

  const KEY_CALL_TYPES = [
    { id: "discovery", label: "Discovery Call", icon: Phone },
    { id: "demo", label: "Demo Call", icon: Video },
    { id: "onboarding", label: "Onboarding Call", icon: CheckCircle },
    { id: "handoff", label: "Handoff Call", icon: Target },
  ];

  // Scroll-to-highlight effect for cross-layer navigation
  useEffect(() => {
    if (highlightField && sectionRefs.current[highlightField]) {
      setTimeout(() => {
        sectionRefs.current[highlightField]?.scrollIntoView({ behavior: motionSafeScrollBehavior(), block: "center" });
        sectionRefs.current[highlightField]?.classList.add("ring-2", "ring-amber-400", "ring-offset-2");
        setTimeout(() => {
          sectionRefs.current[highlightField]?.classList.remove("ring-2", "ring-amber-400", "ring-offset-2");
        }, 3000);
      }, 300);
    }
  }, [highlightField]);

  // Apply prefill data when available (from Promote workflow)
  useEffect(() => {
    if (prefillData && panel) {
      const currentData: Record<string, any> = {};
      Object.keys(panel).forEach(key => {
        currentData[key] = (panel as any)[key];
      });
      // Task #4510: same legacy-alias normalization as startEditing — the
      // edit-all draft must speak canonical product ids too.
      if (panel.productTypes != null) {
        currentData.productTypes = normalizeProductList(panel.productTypes);
      }
      Object.assign(currentData, prefillData);
      setEditData(currentData);
      setEditingSection("all");
    }
  }, [prefillData, panel]);

  const saveMutation = useMutation({
    mutationFn: async (data: Record<string, any>) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...data, reason: saveReason || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "history"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/command-panel-summaries"] }); // fire-and-forget: cache refresh only
      logActivity("save", "Updated command panel", { clientId, section: editingSection });
      toast({ title: "Command Panel updated" });
      setEditingSection(null);
      setEditData({});
      setSaveReason("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/review`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to mark as reviewed");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/command-panel-summaries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Marked as reviewed" });
    },
  });

  type PandadocDoc = {
    id: string;
    documentId: string;
    title: string;
    status: string;
    createdDate: string | null;
    completedDate: string | null;
    recipientsJson: any;
    contentText: string | null;
    linkedClientId: string | null;
    lastSyncedAt: string | null;
    pandadocAppUrl?: string | null;
  };

  const { data: clientContracts, isLoading: contractsLoading } = useQuery<PandadocDoc[]>({
    queryKey: ["/api/clients", clientId, "pandadoc-documents"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/pandadoc-documents`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: deferredStep2,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const { data: allPandadocDocs } = useQuery<PandadocDoc[]>({
    queryKey: ["/api/integrations/pandadoc/documents", contractSearch],
    queryFn: async () => {
      const params = contractSearch ? `?search=${encodeURIComponent(contractSearch)}` : "";
      const res = await fetch(`/api/integrations/pandadoc/documents${params}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: contractPickerOpen,
  });

  const { data: contractDetail } = useQuery<PandadocDoc | null>({
    queryKey: ["/api/integrations/pandadoc/documents", contractDetailOpen],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/pandadoc/documents/${contractDetailOpen}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!contractDetailOpen,
  });

  const contractPdfPreviewLoadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!contractDetailOpen) {
      contractPdfPreviewLoadRef.current = null;
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    const docId = contractDetailOpen;

    const load = () => {
      setContractPdfPreviewLoading(true);
      setContractPdfPreviewError(null);
      setContractPdfPreviewNotReady(false);
      setContractPdfPreviewDisconnected(false);
      setContractPdfPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      void (async () => { // fire-and-forget: background contract preview load, errors handled inside
        try {
          const res = await fetch(
            `/api/integrations/pandadoc/documents/${docId}/pdf`,
            { credentials: "include" },
          );
          if (cancelled) return;
          if (!res.ok) {
            let message = "Could not load this contract preview right now.";
            try {
              const body = await res.json();
              if (body?.error) message = String(body.error);
            } catch {}
            if (res.status === 503) {
              setContractPdfPreviewNotReady(true);
            } else if (res.status === 409) {
              setContractPdfPreviewDisconnected(true);
            }
            setContractPdfPreviewError(message);
            return;
          }
          const blob = await res.blob();
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          if (createdUrl) URL.revokeObjectURL(createdUrl);
          createdUrl = url;
          setContractPdfPreviewUrl(url);
        } catch (err: any) {
          if (cancelled) return;
          setContractPdfPreviewError(err?.message || "Could not load this contract preview right now.");
        } finally {
          if (!cancelled) setContractPdfPreviewLoading(false);
        }
      })();
    };

    contractPdfPreviewLoadRef.current = load;
    load();

    return () => {
      cancelled = true;
      contractPdfPreviewLoadRef.current = null;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [contractDetailOpen]);

  const linkContractMutation = useMutation({
    mutationFn: async (docId: string) => {
      const res = await fetch(`/api/integrations/pandadoc/documents/${docId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ clientId }),
      });
      if (!res.ok) throw new Error("Failed to link document");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "pandadoc-documents"] }); // fire-and-forget: cache refresh only
      setContractPickerOpen(false);
      setContractSearch("");
      toast({ title: "Contract linked" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const unlinkContractMutation = useMutation({
    mutationFn: async (docId: string) => {
      const res = await fetch(`/api/integrations/pandadoc/documents/${docId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ clientId: null }),
      });
      if (!res.ok) throw new Error("Failed to unlink document");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "pandadoc-documents"] }); // fire-and-forget: cache refresh only
      toast({ title: "Contract unlinked" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const startEditing = useCallback((section: string) => {
    if (!canEdit) return;
    if (section === "data-access") {
      const draft: Record<string, string> = {};
      DATA_ACCESS_CATEGORIES.forEach(cat => {
        draft[cat.id] = dataAccess?.find((d: DataAccessEntry) => d.category === cat.id)?.status || "unknown";
      });
      setDataAccessDraft(draft);
      setEditingSection(section);
      setSaveReason("");
      return;
    }
    if (section === "terminology") {
      const current = client.terminology || {};
      const draft: Record<string, string> = {};
      terminologyKeys.forEach(key => {
        draft[key] = current[key] || "";
      });
      setEditData(draft);
      setEditingSection(section);
      setSaveReason("");
      return;
    }
    const currentData: Record<string, any> = {};
    if (panel) {
      Object.keys(panel).forEach(key => {
        currentData[key] = (panel as any)[key];
      });
      // Task #4510: stored productTypes may carry legacy aliases (e.g. plural
      // "webinars") the canonical-id checkboxes can't see or remove. Normalize
      // the draft up front so edit state reflects what's stored and any save
      // persists canonical ids (healing the stored row). A null column stays
      // null — the PUT treats missing/null productTypes differently ([] would
      // defeat first-save inheritance from clients.products).
      if (panel.productTypes != null) {
        currentData.productTypes = normalizeProductList(panel.productTypes);
      }
    }
    setEditData(currentData);
    setEditingSection(section);
    setSaveReason("");
  }, [panel, canEdit, dataAccess, client.terminology]);

  const cancelEditing = useCallback(() => {
    setEditingSection(null);
    setEditData({});
    setDataAccessDraft({});
    setSaveReason("");
  }, []);

  const handleSave = useCallback(() => {
    if (editingSection === "data-access") {
      const promises = Object.entries(dataAccessDraft).map(([category, status]) => {
        const current = dataAccess?.find((d: DataAccessEntry) => d.category === category)?.status || "unknown";
        if (status !== current) {
          return updateDataAccessMutation.mutateAsync({ category, status });
        }
        return Promise.resolve();
      });
      Promise.all(promises)
        .then(() => {
          setEditingSection(null);
          setDataAccessDraft({});
        })
        .catch(() => {
          toast({ title: "Some data access updates failed", variant: "destructive" });
        });
      return;
    }
    if (editingSection === "terminology") {
      const filteredEntries = Object.entries(editData).filter(([, v]) => typeof v === "string" && (v as string).trim());
      const cleaned = filteredEntries.length > 0
        ? (Object.fromEntries(filteredEntries) as NonNullable<ClientTerminology>)
        : null;
      onUpdateClient?.({ terminology: cleaned });
      setEditingSection(null);
      setEditData({});
      return;
    }
    // Task #4022: the product-budget requirements are enforced only in the
    // flows that actually expose the product/budget fields — the Products &
    // Budget section and the edit-all/create flow ("all"). startEditing copies
    // the WHOLE panel into the draft for every section, so a client already in
    // a product-without-budget state (e.g. LSA selected, no LSA budget stored)
    // must not have unrelated section saves (Identity, Onboarding, Strategy, …)
    // blocked by a validation for fields those sections don't even render.
    //
    // Task #4027 decision: the product-without-budget state IS allowed to
    // persist indefinitely from non-products saves. Budgets must come from
    // operators (never invented), so blocking saves or auto-filling would be
    // worse than the gap. The read view renders a visible "Budget missing"
    // notice per affected product (renderMissingBudgetNotice) until an
    // operator enters the real number in Products & Budget.
    //
    // Task #4510 narrows the save-time requirement to edits that CREATE or
    // WORSEN a gap: adding a product with no budget entered, or clearing the
    // stored budget of a still-selected product. A pre-existing gap on an
    // untouched product no longer blocks — otherwise removing one product
    // was impossible without inventing budgets for the others (the exact
    // trap the reported client sat in: webinar removal blocked by Google Ads
    // and LSA budget gaps the operator wasn't editing).
    if (editingSection === "products" || editingSection === "all") {
      const draftProducts: string[] = normalizeProductList(editData.productTypes || []);
      const storedProducts: string[] = normalizeProductList(panel?.productTypes || []);
      const budgetChecks = [
        { id: "google_ads", budgetField: "googleAdsBudget" as const, blockToast: "Google Ads Budget is required when Google Ads is selected" },
        { id: "webinar", budgetField: "webinarBudget" as const, blockToast: "Webinar Budget is required when Webinars is selected" },
        { id: "lsa", budgetField: "lsaBudget" as const, blockToast: "LSA Budget is required when LSA is selected" },
      ];
      for (const check of budgetChecks) {
        if (!draftProducts.includes(check.id)) continue;
        if (editData[check.budgetField]) continue;
        const newlyAdded = !storedProducts.includes(check.id);
        const clearsStoredBudget = panel?.[check.budgetField] != null;
        if (newlyAdded || clearsStoredBudget) {
          toast({ title: check.blockToast, variant: "destructive" });
          return;
        }
      }
    }
    saveMutation.mutate(editData);
  }, [editData, editingSection, panel, dataAccessDraft, dataAccess, saveMutation, toast, onUpdateClient, updateDataAccessMutation]);

  const moveMarket = useCallback((direction: "up" | "down", index: number) => {
    const markets = [...(editData.priorityMarkets || [])];
    if (direction === "up" && index > 0) {
      [markets[index - 1], markets[index]] = [markets[index], markets[index - 1]];
    } else if (direction === "down" && index < markets.length - 1) {
      [markets[index], markets[index + 1]] = [markets[index + 1], markets[index]];
    }
    setEditData(prev => ({ ...prev, priorityMarkets: markets }));
  }, [editData]);

  const sectionHasExistingData = useCallback((section: string): boolean => {
    if (!panel) return false;
    if (section === "data-access" || section === "terminology") {
      return false;
    }
    const sectionFields: Record<string, (keyof typeof panel)[]> = {
      identity: ["accountOwnerId", "secondaryOwnerIds", "clientPreferences", "internalHandlingNotes", "googleDriveFolderLink", "googleDriveFolderName", "zoomRecordingsFolderId", "zoomRecordingsFolderLink", "zoomRecordingsFolderName", "rerReportsFolderId", "rerReportsFolderLink", "rerReportsFolderName", "externalSystemLinks"],
      onboarding: ["onboardingNotes"],
      strategy: ["annualRevenueGoal", "quarterPrimaryObjective", "approvedTerritory", "priorityMarkets", "secondaryMarkets", "geographicExpansionNotes"],
      products: ["productTypes", "productStatusNotes", "googleAdsBudget", "webinarBudget", "lsaBudget", "googleAdsTargetAreas", "googleAdsTargetingMethod", "googleAdsExcludedAreas", "googleAdsGeoNotes", "webinarTargetAreas", "webinarGeoNotes"],
    };
    const fields = sectionFields[section];
    if (!fields) return false;
    return fields.some(field => {
      const value = panel[field];
      if (value == null) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (typeof value === "string") return value.trim().length > 0;
      return true;
    });
  }, [panel]);

  const needsMonthlyReview = !isReviewedThisMonth(panel?.lastReviewedAt as string | null);

  // Task #4510: the read view's product list, per-product sections, and
  // missing-budget notices must recognize legacy stored aliases (e.g. plural
  // "webinars"), so every display read goes through the canonical list. The
  // edit draft is normalized separately in startEditing/the prefill effect.
  const panelProducts: string[] = normalizeProductList(panel?.productTypes || []);

  const getUserName = (userId: string | null) => {
    if (!userId) return "Unknown";
    const u = allUsers.find(u => u.id === userId);
    return u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Unknown" : "Unknown";
  };

  const formatCurrency = (val: number | null) => {
    if (val == null) return "—";
    return `$${val.toLocaleString()}`;
  };

  // Task #4027 — a product can legitimately sit in a selected-without-budget
  // state (Task #4022 deliberately lets non-products saves persist it), but
  // that gap was invisible until someone opened Products & Budget. Surface it
  // right on the read view so operators see and close it.
  const renderMissingBudgetNotice = (productId: string, productLabel: string) => (
    <p
      className="text-caption font-medium text-red-600 flex items-center gap-1"
      data-testid={`warning-missing-budget-${productId}`}
    >
      <AlertTriangle className="w-3 h-3 shrink-0" />
      Budget missing — {productLabel} is selected but no budget is entered. Edit Products &amp; Budget to add it.
    </p>
  );

  // Empty state - editable users with guided prompts
  if (!panel && !isLoading && !isError && editingSection !== "all" && canEdit) {
    return (
      <Card className="bg-card border-border" data-testid="card-command-panel-empty">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Command Panel
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center py-8 space-y-6">
            <div className="w-16 h-16 mx-auto bg-surface-warm-1 rounded-full flex items-center justify-center">
              <Target className="w-8 h-8 text-primary/40" />
            </div>
            <div>
              <p className="text-foreground font-medium">Set up this client's Command Panel</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-lg mx-auto">
                The Command Panel is your single source of truth for this client — who owns the account, what they're paying for, and where they're headed. GBP locations are managed within Products & Budget.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg mx-auto text-left">
              <div className="flex items-start gap-2 p-3 bg-surface-warm-1 rounded-lg">
                <Shield className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Identity & Ownership</p>
                  <p className="text-xs text-muted-foreground">Owner, contract, links, and preferences</p>
                </div>
              </div>
              <div className="flex items-start gap-2 p-3 bg-surface-warm-1 rounded-lg">
                <Phone className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Onboarding Information</p>
                  <p className="text-xs text-muted-foreground">Key calls and onboarding notes</p>
                </div>
              </div>
              <div className="flex items-start gap-2 p-3 bg-surface-warm-1 rounded-lg">
                <Target className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Strategic Direction</p>
                  <p className="text-xs text-muted-foreground">Revenue goals, markets, and territory</p>
                </div>
              </div>
              <div className="flex items-start gap-2 p-3 bg-surface-warm-1 rounded-lg">
                <DollarSign className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Products & Budget</p>
                  <p className="text-xs text-muted-foreground">Active products, spend, and bottlenecks</p>
                </div>
              </div>
            </div>
            <Button
              className="bg-primary hover:bg-primary/90"
              disabled={saveMutation.isPending}
              onClick={() => {
                saveMutation.mutate({
                  productTypes: [],
                  priorityMarkets: [],
                  secondaryMarkets: [],
                  externalSystemLinks: [],
                });
              }}
              data-testid="button-create-command-panel"
            >
              <Plus className="w-4 h-4 mr-1" />
              {saveMutation.isPending ? "Creating..." : "Create Command Panel"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }


  if (isError) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-center">
          <Shield className="w-12 h-12 mx-auto mb-4 text-primary/30" />
          <p className="text-foreground font-medium mb-2" data-testid="command-panel-access-denied">
            {error?.message || "Unable to load Command Panel"}
          </p>
          <p className="text-sm text-muted-foreground">
            Please contact your team lead if you believe you should have access.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6" data-testid="command-panel-skeleton">
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-48" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-5/6" />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-36" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!panel && !canEdit) {
    return (
      <div className="text-center py-12 text-muted-foreground" data-testid="command-panel-empty-state">
        <Shield className="w-12 h-12 mx-auto mb-4 text-primary/20" />
        <p className="text-base font-medium mb-2">No Command Panel data yet</p>
        <p className="text-sm max-w-md mx-auto">
          The command panel will display the strategic truth for this client once it's been set up by the account team.
        </p>
      </div>
    );
  }

  const renderEditActions = (section?: string) => {
    const showReason = section ? sectionHasExistingData(section) : true;
    const isSaving = saveMutation.isPending || updateDataAccessMutation.isPending;
    return (
      <div className="space-y-3 pt-3 border-t border-border">
        {showReason && (
          <div>
            <Label className="text-xs text-muted-foreground">Reason for change (optional)</Label>
            <Input
              value={saveReason}
              onChange={(e) => setSaveReason(e.target.value)}
              placeholder="Why this change?"
              className="h-8 text-sm mt-1"
              data-testid="input-save-reason"
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90"
            onClick={handleSave}
            disabled={isSaving}
            data-testid="button-save-section"
          >
            <Check className="w-3.5 h-3.5 mr-1" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} data-testid="button-cancel-section">
            <X className="w-3.5 h-3.5 mr-1" />
            Cancel
          </Button>
        </div>
      </div>
    );
  };

  const safeDisplayString = (val: any): string => {
    if (val == null) return "";
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "object") {
      if (val.name) return String(val.name);
      if (val.label) return String(val.label);
      try {
        return JSON.stringify(val);
      } catch {
        return "[object]";
      }
    }
    return String(val);
  };

  const renderField = (label: string, value: any, type: "text" | "list" | "currency" = "text") => {
    if (type === "list" && Array.isArray(value) && value.length > 0) {
      return (
        <div>
          <p className="text-xs text-muted-foreground mb-1">{label}</p>
          <div className="flex flex-wrap gap-1">
            {value.map((v, i) => (
              <Badge key={i} variant="secondary" className="text-xs bg-surface-warm-1 text-primary dark:text-foreground border-border">
                {safeDisplayString(v)}
              </Badge>
            ))}
          </div>
        </div>
      );
    }
    if (type === "currency") {
      return (
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-sm font-medium">{formatCurrency(value)}</p>
        </div>
      );
    }
    return (
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium whitespace-pre-wrap">{safeDisplayString(value) || "—"}</p>
      </div>
    );
  };

  const renderLink = (label: string, url: string | null) => {
    if (!url) return null;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-warm-1 rounded-lg text-sm text-primary-ink hover:bg-primary/10 transition-colors"
        data-testid={`link-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <ExternalLink className="w-3.5 h-3.5" />
        {label}
      </a>
    );
  };

  const isEditing = (section: string) => editingSection === section || editingSection === "all";

  // Task #999: per-section field maps for the "Last edited by X" affordance.
  // Sections backed by `command_panel_history` map to the panel column names
  // recorded there; sections without history (terminology, data-access)
  // get an empty list and render a "—" placeholder.
  const SECTION_HISTORY_FIELDS: Record<string, string[]> = {
    identity: [
      "accountOwnerId", "secondaryOwnerIds",
      "googleDriveFolderLink", "googleDriveFolderName",
      "zoomRecordingsFolderLink", "zoomRecordingsFolderName",
      "rerReportsFolderLink", "rerReportsFolderName",
      "externalSystemLinks",
      "clientPreferences", "internalHandlingNotes",
      "contractDocumentId", "contractDocumentName",
    ],
    onboarding: ["onboardingNotes"],
    strategy: [
      "annualRevenueGoal", "quarterPrimaryObjective",
      "approvedTerritory", "priorityMarkets", "secondaryMarkets",
      "geographicExpansionNotes",
    ],
    products: [
      "productTypes", "productStatusNotes", "currentBottleneck", "budgetPosture",
      "lsaBudget",
      "googleAdsBudget", "googleAdsTargetAreas", "googleAdsTargetingMethod",
      "googleAdsExcludedAreas", "googleAdsGeoNotes",
      "webinarBudget", "webinarTargetAreas", "webinarGeoNotes",
    ],
    "data-access": [],
    terminology: [],
  };

  const renderSectionHeader = (title: string, icon: React.ReactNode, section: string) => (
    <CardTitle className="text-foreground flex items-center gap-2">
      {icon}
      {title}
      <span className="ml-2">
        <CommandPanelSectionAuditInfo
          section={section}
          fields={SECTION_HISTORY_FIELDS[section] ?? []}
          history={commandPanelHistoryEntries}
          allUsers={allUsers}
          onOpenHistory={(fields) => {
            setHistorySectionFields(fields.length > 0 ? fields : null);
            setHistoryOpen(true);
          }}
        />
      </span>
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-xs"
          data-testid={`button-edit-${section}`}
          onClick={() => isEditing(section) ? cancelEditing() : startEditing(section)}
        >
          {isEditing(section) ? (
            <>
              <X className="w-3.5 h-3.5 mr-1" />
              Cancel
            </>
          ) : (
            <>
              <Pencil className="w-3.5 h-3.5 mr-1" />
              Edit
            </>
          )}
        </Button>
      )}
    </CardTitle>
  );

  return (
    <div className="space-y-4" data-testid="command-panel">
      {needsMonthlyReview && (
        <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg" data-testid="banner-monthly-review">
          <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800">Monthly review required</p>
            <p className="text-xs text-amber-600">
              This command panel must be reviewed before reports can be finalized this month.
              {panel?.lastReviewedAt ? ` Last reviewed: ${format(new Date(panel.lastReviewedAt), "MMM d, yyyy")}` : " Never reviewed."}
              {panel?.lastReviewedAt && (
                <button
                  className="ml-2 underline hover:text-amber-800 transition-colors"
                  onClick={() => setHistoryOpen(true)}
                  data-testid="link-view-changes-since-review"
                >
                  View what changed
                </button>
              )}
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => reviewMutation.mutate()}
              disabled={reviewMutation.isPending}
              data-testid="button-confirm-review"
            >
              Confirm & Save
            </Button>
          )}
        </div>
      )}

      {/* Review Status Header */}
      <Card className="bg-card border-border" data-testid="card-command-panel-header">
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                <h3 className="font-semibold text-foreground">Command Panel</h3>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="w-3.5 h-3.5" />
                <span data-testid="text-last-reviewed">
                  {panel?.lastReviewedAt
                    ? `Reviewed ${format(new Date(panel.lastReviewedAt), "MMM d, yyyy")} by ${getUserName(panel?.lastReviewedBy ?? null)}`
                    : "Never reviewed"}
                </span>
              </div>
            </div>
            {panel && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHistoryOpen(true)}
                  data-testid="button-open-history"
                >
                  <History className="w-3.5 h-3.5 mr-1" />
                  History
                </Button>
                {!needsMonthlyReview && canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-green-200 text-green-700 hover:bg-green-50"
                    onClick={() => reviewMutation.mutate()}
                    disabled={reviewMutation.isPending}
                    data-testid="button-mark-reviewed"
                  >
                    <Check className="w-3.5 h-3.5 mr-1" />
                    Mark as Reviewed
                  </Button>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

        {/* Identity & Ownership */}
        <Card className="bg-card border-border" data-testid="card-identity">
          <CardHeader className="pb-3">
            {renderSectionHeader("Identity & Ownership", <Shield className="w-4 h-4" />, "identity")}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="p-3 bg-surface-warm-1/60 border border-primary/8 rounded-lg space-y-2 mb-3" data-testid="card-client-info-context">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground uppercase tracking-wide flex items-center gap-1">
                  <Building2 className="w-3 h-3" />
                  Client Information
                </p>
                {canEdit && onEditClient && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-primary-ink hover:bg-primary/5"
                    onClick={onEditClient}
                    data-testid="button-edit-client-details"
                  >
                    <Pencil className="w-3 h-3 mr-1.5" />
                    Edit client details
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                {client.contactName && (
                  <div className="min-w-0">
                    <p className="text-caption text-muted-foreground uppercase">Contact</p>
                    <p className="text-sm font-medium text-foreground break-words">{client.contactName}</p>
                  </div>
                )}
                {client.contactEmail && (
                  <div className="min-w-0">
                    <p className="text-caption text-muted-foreground uppercase">Email</p>
                    {/* Emails are single unbreakable tokens — break-all stops
                        them widening the page in a half-width phone cell. */}
                    <p className="text-sm font-medium text-foreground break-all">{client.contactEmail}</p>
                  </div>
                )}
                {client.contactPhone && (
                  <div className="min-w-0">
                    <p className="text-caption text-muted-foreground uppercase">Phone</p>
                    {/* Task #4305 — same message/call affordances as contact
                        rows; deep-links into the Conversation Hub. */}
                    <div className="flex items-center min-w-0">
                      <p className="text-sm font-medium text-foreground break-words min-w-0">{client.contactPhone}</p>
                      <PhoneHubIconActions
                        phone={client.contactPhone}
                        contactName={client.contactName}
                        clientId={clientId}
                        messageTestId="button-client-info-message"
                        callTestId="button-client-info-call"
                      />
                    </div>
                  </div>
                )}
                <div>
                  <p className="text-caption text-muted-foreground uppercase">Consult Type</p>
                  <p
                    className={client.consultType
                      ? "text-sm font-medium text-foreground capitalize"
                      : "text-sm text-muted-foreground"}
                    data-testid="text-client-consult-type"
                  >
                    {client.consultType || "No consult type selected"}
                  </p>
                </div>
                {client.clientStartDate && (
                  <div>
                    <p className="text-caption text-muted-foreground uppercase">Client Since</p>
                    <p className="text-sm font-medium text-foreground">{format(new Date(client.clientStartDate), "MMMM yyyy")}</p>
                  </div>
                )}
                <div className="col-span-2">
                  <p className="text-caption text-muted-foreground uppercase">Practice Areas</p>
                  {client.practiceAreas && client.practiceAreas.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {client.practiceAreas.map(area => (
                        <span key={area} className="px-2 py-0.5 bg-card rounded text-xs text-foreground">
                          {area}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-client-practice-areas-empty">
                      No practice areas selected
                    </p>
                  )}
                </div>
              </div>
            </div>
            {isEditing("identity") ? (
              <>
                {renderField("Client Name", client.firmName)}
                {renderField("Account Owner", getUserName(client.ownerId))}
                <div>
                  <Label className="text-xs text-muted-foreground">Secondary Owners</Label>
                  <Select
                    value={editData.secondaryOwnerIds?.[0] || "none"}
                    onValueChange={(val) => {
                      const current = editData.secondaryOwnerIds || [];
                      if (val === "none") {
                        setEditData(prev => ({ ...prev, secondaryOwnerIds: [] }));
                      } else if (!current.includes(val)) {
                        setEditData(prev => ({ ...prev, secondaryOwnerIds: [...current, val] }));
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-secondary-owner">
                      <SelectValue placeholder="Add secondary owner" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {allUsers.filter(u => u.id !== client.ownerId).map(u => (
                        <SelectItem key={u.id} value={u.id}>
                          {`${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editData.secondaryOwnerIds?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {editData.secondaryOwnerIds.map((ownerId: string) => (
                        <Badge key={ownerId} variant="secondary" className="text-xs">
                          {getUserName(ownerId)}
                          <button
                            className="ml-1"
                            onClick={() => setEditData(prev => ({
                              ...prev,
                              secondaryOwnerIds: (prev.secondaryOwnerIds || []).filter((id: string) => id !== ownerId),
                            }))}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border-t pt-3 mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-foreground">
                      <FileText className="w-3.5 h-3.5" />
                      <span className="text-xs font-semibold">Contract</span>
                    </div>
                    {!isReadOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-caption"
                        onClick={() => setContractPickerOpen(true)}
                        data-testid="button-link-contract-edit"
                      >
                        <Plus className="w-3 h-3 mr-0.5" />
                        Link
                      </Button>
                    )}
                  </div>
                  {contractsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : !clientContracts || clientContracts.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70">No contracts linked</p>
                  ) : (
                    <div className="space-y-1.5">
                      {clientContracts.map((doc) => {
                        const statusLabel = doc.status.replace("document.", "").replace(/_/g, " ");
                        const statusColors: Record<string, string> = {
                          "completed": "bg-green-100 text-green-700",
                          "sent": "bg-blue-100 text-blue-700",
                          "draft": "bg-muted text-muted-foreground",
                          "viewed": "bg-amber-100 text-amber-700",
                          "approved": "bg-green-100 text-green-700",
                        };
                        const colorClass = statusColors[statusLabel] || "bg-muted text-muted-foreground";
                        return (
                          <div key={doc.id} className="flex items-center justify-between gap-2 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                className="text-primary-ink hover:underline truncate text-xs font-medium"
                                onClick={() => setContractDetailOpen(doc.id)}
                              >
                                {doc.title}
                              </button>
                              <Badge variant="outline" className={`text-caption px-1 py-0 capitalize ${colorClass}`}>
                                {statusLabel}
                              </Badge>
                            </div>
                            {!isReadOnly && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 w-5 p-0 text-red-500 hover:text-red-600"
                                onClick={() => unlinkContractMutation.mutate(doc.id)}
                              >
                                <Unlink className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="border-t pt-3 mt-3 space-y-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Google Drive Folder (legacy — integration retired)</Label>
                    <div className="flex items-center gap-2 mt-1">
                      {(editData.googleDriveFolderName || editData.googleDriveFolderLink) ? (
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <a
                            href={editData.googleDriveFolderLink || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary-ink hover:underline truncate"
                            data-testid="link-google-drive-folder"
                          >
                            {editData.googleDriveFolderName || editData.googleDriveFolderLink}
                          </a>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => setEditData(prev => ({ ...prev, googleDriveFolderLink: null, googleDriveFolderName: null }))}
                            data-testid="button-clear-google-drive"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground/70 flex-1">None</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Zoom Recordings Folder (legacy — integration retired)</Label>
                    <div className="flex items-center gap-2 mt-1">
                      {(editData.zoomRecordingsFolderLink || editData.zoomRecordingsFolderName) ? (
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <a
                            href={editData.zoomRecordingsFolderLink || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary-ink hover:underline truncate"
                            data-testid="link-zoom-recordings-folder"
                          >
                            {editData.zoomRecordingsFolderName || "Zoom Recordings"}
                          </a>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => setEditData(prev => ({ ...prev, zoomRecordingsFolderId: null, zoomRecordingsFolderLink: null, zoomRecordingsFolderName: null }))}
                            data-testid="button-clear-zoom-folder"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground/70 flex-1">None</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">RER Reports Folder (legacy — integration retired)</Label>
                    <div className="flex items-center gap-2 mt-1">
                      {(editData.rerReportsFolderLink || editData.rerReportsFolderName) ? (
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <a
                            href={editData.rerReportsFolderLink || "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary-ink hover:underline truncate"
                            data-testid="link-rer-reports-folder"
                          >
                            {editData.rerReportsFolderName || "RER Reports"}
                          </a>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0"
                            onClick={() => setEditData(prev => ({ ...prev, rerReportsFolderId: null, rerReportsFolderLink: null, rerReportsFolderName: null }))}
                            data-testid="button-clear-rer-folder"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground/70 flex-1">None</span>
                      )}
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">External System Links</Label>
                  <div className="space-y-2 mt-1">
                    {(editData.externalSystemLinks || []).map((link: ExternalSystemLink, i: number) => (
                      <div key={i} className="flex gap-2 items-center">
                        <Input
                          value={link.label}
                          onChange={(e) => {
                            const links = [...(editData.externalSystemLinks || [])];
                            links[i] = { ...links[i], label: e.target.value };
                            setEditData(prev => ({ ...prev, externalSystemLinks: links }));
                          }}
                          className="h-8 text-sm w-1/3"
                          placeholder="Label"
                          data-testid={`input-ext-link-label-${i}`}
                        />
                        <Input
                          value={link.url}
                          onChange={(e) => {
                            const links = [...(editData.externalSystemLinks || [])];
                            links[i] = { ...links[i], url: e.target.value };
                            setEditData(prev => ({ ...prev, externalSystemLinks: links }));
                          }}
                          className="h-8 text-sm flex-1"
                          placeholder="https://..."
                          data-testid={`input-ext-link-url-${i}`}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0"
                          onClick={() => {
                            const links = (editData.externalSystemLinks || []).filter((_: any, idx: number) => idx !== i);
                            setEditData(prev => ({ ...prev, externalSystemLinks: links }));
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => {
                        const links = [...(editData.externalSystemLinks || []), { label: "", url: "" }];
                        setEditData(prev => ({ ...prev, externalSystemLinks: links }));
                      }}
                      data-testid="button-add-ext-link"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add Link
                    </Button>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Client Preferences</Label>
                  <Textarea
                    value={editData.clientPreferences || ""}
                    onChange={(e) => setEditData(prev => ({ ...prev, clientPreferences: e.target.value }))}
                    className="text-sm min-h-[60px]"
                    data-testid="input-client-preferences"
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Internal Handling Notes</Label>
                  <Textarea
                    value={editData.internalHandlingNotes || ""}
                    onChange={(e) => setEditData(prev => ({ ...prev, internalHandlingNotes: e.target.value }))}
                    className="text-sm min-h-[60px]"
                    data-testid="input-internal-notes"
                  />
                </div>
                {renderEditActions("identity")}
              </>
            ) : (
              <>
                {renderField("Client Name", client.firmName)}
                {renderField("Account Owner", getUserName(client.ownerId))}
                {renderField("Secondary Owners", panel?.secondaryOwnerIds?.map(id => getUserName(id)) || [], "list")}
                {panel?.lastUpdatedAt && (
                  <div>
                    <p className="text-xs text-muted-foreground">Last Updated</p>
                    <p className="text-sm">{format(new Date(panel.lastUpdatedAt), "MMM d, yyyy")} by {getUserName(panel?.lastUpdatedBy)}</p>
                  </div>
                )}
                {/* Contract */}
                <div className="border-t pt-3 mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-foreground">
                      <FileText className="w-3.5 h-3.5" />
                      <span className="text-xs font-semibold">Contract</span>
                    </div>
                    {!isReadOnly && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-caption"
                        onClick={() => setContractPickerOpen(true)}
                        data-testid="button-link-contract"
                      >
                        <Plus className="w-3 h-3 mr-0.5" />
                        Link
                      </Button>
                    )}
                  </div>
                  {contractsLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  ) : !clientContracts || clientContracts.length === 0 ? (
                    <p className="text-xs text-muted-foreground/70" data-testid="text-no-contracts">No contracts linked</p>
                  ) : (
                    <div className="space-y-1.5">
                      {clientContracts.map((doc) => {
                        const statusLabel = doc.status.replace("document.", "").replace(/_/g, " ");
                        const statusColors: Record<string, string> = {
                          "completed": "bg-green-100 text-green-700",
                          "sent": "bg-blue-100 text-blue-700",
                          "draft": "bg-muted text-muted-foreground",
                          "viewed": "bg-amber-100 text-amber-700",
                          "approved": "bg-green-100 text-green-700",
                        };
                        const colorClass = statusColors[statusLabel] || "bg-muted text-muted-foreground";
                        return (
                          <div key={doc.id} className="flex items-center justify-between gap-2 text-sm" data-testid={`card-contract-${doc.id}`}>
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                className="text-primary-ink hover:underline truncate text-xs font-medium"
                                onClick={() => setContractDetailOpen(doc.id)}
                                data-testid={`button-view-contract-${doc.id}`}
                              >
                                {doc.title}
                              </button>
                              <Badge variant="outline" className={`text-caption px-1 py-0 capitalize ${colorClass}`} data-testid={`badge-contract-status-${doc.id}`}>
                                {statusLabel}
                              </Badge>
                            </div>
                            {!isReadOnly && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-5 w-5 p-0 text-red-500 hover:text-red-600"
                                onClick={() => unlinkContractMutation.mutate(doc.id)}
                                data-testid={`button-unlink-contract-${doc.id}`}
                              >
                                <Unlink className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* Links */}
                <div className="border-t pt-3 mt-3">
                  <p className="text-xs text-muted-foreground mb-2">Links</p>
                  <div className="flex flex-wrap gap-2">
                    {/* Task #4025: the in-app Files tab is the canonical client
                        folder; the Drive folder stays as a legacy reference. */}
                    <a
                      href={`/clients/${clientId}?tab=files`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary rounded-lg text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
                      data-testid="link-client-files"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Client Files
                    </a>
                    {renderLink((panel?.googleDriveFolderName || "Google Drive") + " (legacy)", panel?.googleDriveFolderLink ?? null)}
                    {panel?.zoomRecordingsFolderLink && renderLink(
                      panel.zoomRecordingsFolderName || "Zoom Recordings",
                      panel.zoomRecordingsFolderLink
                    )}
                    {panel?.rerReportsFolderLink && renderLink(
                      panel.rerReportsFolderName || "RER Reports",
                      panel.rerReportsFolderLink
                    )}
                    {Array.isArray(panel?.externalSystemLinks) && panel.externalSystemLinks.map((link: ExternalSystemLink, i: number) => (
                      renderLink(link.label, link.url)
                    ))}
                    {!panel?.googleDriveFolderLink && !panel?.zoomRecordingsFolderLink && !panel?.rerReportsFolderLink && (!panel?.externalSystemLinks || (panel.externalSystemLinks as any[]).length === 0) && (
                      <p className="text-xs text-muted-foreground/70">No links added yet</p>
                    )}
                  </div>
                </div>
                {panel?.clientPreferences && (
                  <div className="border-t pt-3 mt-3">
                    {renderField("Client Preferences", panel.clientPreferences)}
                  </div>
                )}
                {panel?.internalHandlingNotes && (
                  <div className={panel?.clientPreferences ? "" : "border-t pt-3 mt-3"}>
                    {renderField("Internal Notes", panel.internalHandlingNotes)}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Task #970: Pending Front contact suggestions */}
        {canEdit && contactSuggestions.length > 0 && (
          <Card
            className="bg-amber-50 border-amber-300"
            data-testid="card-front-contact-suggestions"
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-amber-900 flex items-center gap-2 text-base">
                  <Mail className="w-4 h-4" />
                  Pending Contact Suggestions
                  <Badge
                    variant="secondary"
                    className="bg-amber-200 text-amber-900 ml-1"
                    data-testid="badge-front-suggestions-count"
                  >
                    {contactSuggestions.length}
                  </Badge>
                </CardTitle>
              </div>
              <p className="text-xs text-amber-800/80">
                New email participants discovered by the Front sync. Promote to add
                them to a client contact, or dismiss to drop them.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {contactSuggestionsLoading && (
                <p className="text-xs text-amber-800/70">Loading suggestions…</p>
              )}
              {contactSuggestions.map((s) => {
                const candidateEmails = (s.candidate?.emails ?? []).filter(
                  (e): e is string => !!e,
                );
                const overrides = suggestionEmailSelection[s.id] ?? {};
                const selected = candidateEmails.filter((e) => overrides[e] !== false);
                const candidateName = s.candidate?.name?.trim() || "Auto-discovered Contact";
                const subject = s.sourceRef?.subject;
                const snippet = s.sourceRef?.snippet;
                const conversationId = s.sourceRef?.conversationId;
                const captured = s.sourceRef?.capturedAt || s.createdAt;
                const isPromoting =
                  promoteContactSuggestionMutation.isPending &&
                  promoteContactSuggestionMutation.variables?.id === s.id;
                const isDismissing =
                  dismissContactSuggestionMutation.isPending &&
                  dismissContactSuggestionMutation.variables === s.id;
                return (
                  <div
                    key={s.id}
                    className="border border-amber-200 rounded-lg p-3 bg-card space-y-2"
                    data-testid={`front-suggestion-${s.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground" data-testid={`text-suggestion-name-${s.id}`}>
                          {candidateName}
                        </div>
                        {captured && (
                          <div className="text-caption text-muted-foreground/70">
                            Captured {format(new Date(captured), "MMM d, yyyy h:mm a")}
                          </div>
                        )}
                      </div>
                      {conversationId && (
                        <a
                          href={`https://app.frontapp.com/open/${conversationId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-caption text-primary-ink hover:underline whitespace-nowrap"
                          data-testid={`link-suggestion-front-${s.id}`}
                        >
                          Open in Front <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    {(subject || snippet) && (
                      <div className="text-xs text-muted-foreground bg-surface-warm-1/40 border border-surface-warm-1 rounded p-2">
                        {subject && (
                          <div className="font-medium text-foreground truncate" data-testid={`text-suggestion-subject-${s.id}`}>
                            {subject}
                          </div>
                        )}
                        {snippet && (
                          <div className="line-clamp-2 mt-0.5" data-testid={`text-suggestion-snippet-${s.id}`}>
                            {snippet}
                          </div>
                        )}
                      </div>
                    )}
                    {candidateEmails.length === 0 ? (
                      <p className="text-xs text-red-600">
                        No candidate emails on this suggestion.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {candidateEmails.map((email) => {
                          const checked = overrides[email] !== false;
                          return (
                            <label
                              key={email}
                              className="flex items-center gap-2 text-xs cursor-pointer"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(c) =>
                                  toggleSuggestionEmail(s.id, email, !!c)
                                }
                                data-testid={`checkbox-suggestion-email-${s.id}-${email}`}
                              />
                              <Mail className="w-3 h-3 text-muted-foreground" />
                              <span className="text-foreground">{email}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        className="bg-primary hover:bg-primary/90 h-7 text-xs"
                        disabled={
                          isPromoting ||
                          isDismissing ||
                          selected.length === 0
                        }
                        onClick={() =>
                          promoteContactSuggestionMutation.mutate({
                            id: s.id,
                            emails: selected,
                            contactName: candidateName,
                          })
                        }
                        data-testid={`button-promote-suggestion-${s.id}`}
                      >
                        <Check className="w-3 h-3 mr-1" />
                        {isPromoting ? "Promoting…" : `Promote (${selected.length})`}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={isPromoting || isDismissing}
                        onClick={() => dismissContactSuggestionMutation.mutate(s.id)}
                        data-testid={`button-dismiss-suggestion-${s.id}`}
                      >
                        <X className="w-3 h-3 mr-1" />
                        {isDismissing ? "Dismissing…" : "Dismiss"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Client Contacts */}
        <Card className="bg-card border-border" data-testid="card-client-contacts">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-foreground flex items-center gap-2 text-base">
                <Users className="w-4 h-4" />
                Client Contacts
              </CardTitle>
              {canEdit && !editingContactId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingContactId("new");
                    setContactFormData({ name: "", emails: [""], phones: [""], roleTitle: "", isPrimary: false });
                  }}
                  className="text-primary-ink hover:bg-primary/10 h-7"
                  data-testid="button-add-contact"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {editingContactId === "new" && (
              <div className="border rounded-lg p-3 bg-surface-warm-1/30 space-y-3" data-testid="contact-new-form">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Name *</Label>
                    <Input value={contactFormData.name} onChange={(e) => setContactFormData(p => ({ ...p, name: e.target.value }))} className="h-8 text-sm" placeholder="Contact name" data-testid="input-new-contact-name" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Role / Title</Label>
                    <Input value={contactFormData.roleTitle} onChange={(e) => setContactFormData(p => ({ ...p, roleTitle: e.target.value }))} className="h-8 text-sm" placeholder="e.g. Managing Partner" data-testid="input-new-contact-role" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" /> Emails</Label>
                  <div className="space-y-1 mt-1">
                    {contactFormData.emails.map((email, ei) => (
                      <div key={ei} className="flex gap-1 items-center">
                        <Input value={email} onChange={(e) => { const emails = [...contactFormData.emails]; emails[ei] = e.target.value; setContactFormData(p => ({ ...p, emails })); }} className="h-7 text-sm" placeholder="email@example.com" type="email" data-testid={`input-new-contact-email-${ei}`} />
                        {contactFormData.emails.length > 1 && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setContactFormData(p => ({ ...p, emails: p.emails.filter((_, i) => i !== ei) }))} data-testid={`button-remove-new-email-${ei}`}><X className="w-3 h-3 text-red-500" /></Button>
                        )}
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" className="h-6 text-caption text-primary-ink" onClick={() => setContactFormData(p => ({ ...p, emails: [...p.emails, ""] }))} data-testid="button-add-new-email"><Plus className="w-3 h-3 mr-0.5" /> Add Email</Button>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> Phones</Label>
                  <div className="space-y-1 mt-1">
                    {contactFormData.phones.map((phone, pi) => (
                      <div key={pi} className="flex gap-1 items-center">
                        <Input value={phone} onChange={(e) => { const phones = [...contactFormData.phones]; phones[pi] = e.target.value; setContactFormData(p => ({ ...p, phones })); }} className="h-7 text-sm" placeholder="(555) 123-4567" type="tel" data-testid={`input-new-contact-phone-${pi}`} />
                        {contactFormData.phones.length > 1 && (
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setContactFormData(p => ({ ...p, phones: p.phones.filter((_, i) => i !== pi) }))} data-testid={`button-remove-new-phone-${pi}`}><X className="w-3 h-3 text-red-500" /></Button>
                        )}
                      </div>
                    ))}
                    <Button size="sm" variant="ghost" className="h-6 text-caption text-primary-ink" onClick={() => setContactFormData(p => ({ ...p, phones: [...p.phones, ""] }))} data-testid="button-add-new-phone"><Plus className="w-3 h-3 mr-0.5" /> Add Phone</Button>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox checked={contactFormData.isPrimary} onCheckedChange={(checked) => setContactFormData(p => ({ ...p, isPrimary: !!checked }))} data-testid="checkbox-new-contact-primary" />
                  Primary contact
                </label>
                <div className="flex gap-2">
                  <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => {
                    if (!contactFormData.name.trim()) { toast({ title: "Contact name is required", variant: "destructive" }); return; }
                    createContactMutation.mutate(contactFormData, { onSuccess: () => setEditingContactId(null) });
                  }} disabled={createContactMutation.isPending} data-testid="button-save-new-contact">
                    <Check className="w-3.5 h-3.5 mr-1" /> {createContactMutation.isPending ? "Saving..." : "Save"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingContactId(null)} data-testid="button-cancel-new-contact"><X className="w-3.5 h-3.5 mr-1" /> Cancel</Button>
                </div>
              </div>
            )}
            {(!clientContacts || clientContacts.length === 0) && editingContactId !== "new" && (
              <p className="text-sm text-muted-foreground/70 text-center py-3" data-testid="text-no-contacts">No contacts added yet</p>
            )}
            {clientContacts && clientContacts.map((contact) => (
              <div key={contact.id} className="border rounded-lg p-3 bg-card" data-testid={`contact-card-${contact.id}`}>
                {editingContactId === contact.id ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs text-muted-foreground">Name *</Label>
                        <Input value={contactFormData.name} onChange={(e) => setContactFormData(p => ({ ...p, name: e.target.value }))} className="h-8 text-sm" data-testid={`input-edit-contact-name-${contact.id}`} />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Role / Title</Label>
                        <Input value={contactFormData.roleTitle} onChange={(e) => setContactFormData(p => ({ ...p, roleTitle: e.target.value }))} className="h-8 text-sm" data-testid={`input-edit-contact-role-${contact.id}`} />
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="w-3 h-3" /> Emails</Label>
                      <div className="space-y-1 mt-1">
                        {contactFormData.emails.map((email, ei) => (
                          <div key={ei} className="flex gap-1 items-center">
                            <Input value={email} onChange={(e) => { const emails = [...contactFormData.emails]; emails[ei] = e.target.value; setContactFormData(p => ({ ...p, emails })); }} className="h-7 text-sm" type="email" data-testid={`input-edit-email-${contact.id}-${ei}`} />
                            {contactFormData.emails.length > 1 && (
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setContactFormData(p => ({ ...p, emails: p.emails.filter((_, i) => i !== ei) }))}><X className="w-3 h-3 text-red-500" /></Button>
                            )}
                          </div>
                        ))}
                        <Button size="sm" variant="ghost" className="h-6 text-caption text-primary-ink" onClick={() => setContactFormData(p => ({ ...p, emails: [...p.emails, ""] }))}><Plus className="w-3 h-3 mr-0.5" /> Add Email</Button>
                      </div>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="w-3 h-3" /> Phones</Label>
                      <div className="space-y-1 mt-1">
                        {contactFormData.phones.map((phone, pi) => (
                          <div key={pi} className="flex gap-1 items-center">
                            <Input value={phone} onChange={(e) => { const phones = [...contactFormData.phones]; phones[pi] = e.target.value; setContactFormData(p => ({ ...p, phones })); }} className="h-7 text-sm" type="tel" data-testid={`input-edit-phone-${contact.id}-${pi}`} />
                            {contactFormData.phones.length > 1 && (
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setContactFormData(p => ({ ...p, phones: p.phones.filter((_, i) => i !== pi) }))}><X className="w-3 h-3 text-red-500" /></Button>
                            )}
                          </div>
                        ))}
                        <Button size="sm" variant="ghost" className="h-6 text-caption text-primary-ink" onClick={() => setContactFormData(p => ({ ...p, phones: [...p.phones, ""] }))}><Plus className="w-3 h-3 mr-0.5" /> Add Phone</Button>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs cursor-pointer">
                      <Checkbox checked={contactFormData.isPrimary} onCheckedChange={(checked) => setContactFormData(p => ({ ...p, isPrimary: !!checked }))} />
                      Primary contact
                    </label>
                    <div className="flex gap-2">
                      <Button size="sm" className="bg-primary hover:bg-primary/90" onClick={() => {
                        if (!contactFormData.name.trim()) { toast({ title: "Contact name is required", variant: "destructive" }); return; }
                        updateContactMutation.mutate({ id: contact.id, data: contactFormData });
                      }} disabled={updateContactMutation.isPending} data-testid={`button-save-edit-contact-${contact.id}`}>
                        <Check className="w-3.5 h-3.5 mr-1" /> {updateContactMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingContactId(null)}><X className="w-3.5 h-3.5 mr-1" /> Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground" data-testid={`text-contact-name-${contact.id}`}>{contact.name}</span>
                        {contact.isPrimary && (
                          <Badge variant="secondary" className="text-caption bg-amber-100 text-amber-700">
                            <Star className="w-2.5 h-2.5 mr-0.5" /> Primary
                          </Badge>
                        )}
                        {contact.roleTitle && (
                          <span className="text-xs text-muted-foreground/70" data-testid={`text-contact-role-${contact.id}`}>{contact.roleTitle}</span>
                        )}
                      </div>
                      {contact.emails && contact.emails.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {contact.emails.map((email, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-contact-email-${contact.id}-${i}`}>
                              <Mail className="w-3 h-3" /> {email}
                            </span>
                          ))}
                        </div>
                      )}
                      {contact.phones && contact.phones.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {contact.phones.map((phone, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid={`text-contact-phone-${contact.id}-${i}`}>
                              <Phone className="w-3 h-3" /> {phone}
                              <PhoneHubIconActions
                                phone={phone}
                                contactName={contact.name}
                                clientId={clientId}
                                messageTestId={`button-contact-phone-message-${contact.id}-${i}`}
                                callTestId={`button-contact-phone-call-${contact.id}-${i}`}
                              />
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="pt-0.5">
                        <ContactAuditInfo
                          clientId={clientId}
                          contactId={contact.id}
                          contactName={contact.name}
                          audit={contactAuditByContact.get(contact.id)}
                        />
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost" size="sm" className="h-7 w-7 p-0"
                          onClick={() => {
                            setEditingContactId(contact.id);
                            setContactFormData({
                              name: contact.name,
                              emails: contact.emails && contact.emails.length > 0 ? [...contact.emails] : [""],
                              phones: contact.phones && contact.phones.length > 0 ? [...contact.phones] : [""],
                              roleTitle: contact.roleTitle || "",
                              isPrimary: contact.isPrimary,
                            });
                          }}
                          data-testid={`button-edit-contact-${contact.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5 text-primary" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-7 w-7 p-0"
                          onClick={() => deleteContactMutation.mutate(contact.id)}
                          data-testid={`button-delete-contact-${contact.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

      {/* Onboarding Information */}
      {panel && (
        <Card className="bg-card border-border" data-testid="card-onboarding">
          <CardHeader className="pb-3">
            {renderSectionHeader("Onboarding Information", <Phone className="w-4 h-4" />, "onboarding")}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {KEY_CALL_TYPES.map(({ id, label, icon: Icon }) => {
                const assigned = keyCalls?.find(kc => kc.callType === id);
                const isAssigningThis = keyCallAssigning === id;
                return (
                  <div key={id} className="border rounded-lg p-3 bg-surface-warm-1/30" data-testid={`key-call-slot-${id}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className="w-4 h-4 text-primary" />
                      <span className="text-xs font-medium text-foreground">{label}</span>
                    </div>
                    {assigned?.communication ? (
                      <div className="space-y-1">
                        <button
                          className="text-xs text-primary-ink font-medium hover:underline text-left w-full truncate"
                          onClick={() => setKeyCallDetailOpen(assigned)}
                          data-testid={`button-view-key-call-${id}`}
                        >
                          {assigned.communication.title}
                        </button>
                        <p className="text-caption text-muted-foreground/70">
                          {assigned.communication.timestamp ? format(new Date(assigned.communication.timestamp), "MMM d, yyyy") : ""}
                        </p>
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 text-caption text-red-500 hover:text-red-700 px-1"
                            onClick={() => removeKeyCallMutation.mutate(id)}
                            data-testid={`button-remove-key-call-${id}`}
                          >
                            <Trash2 className="w-2.5 h-2.5 mr-0.5" /> Remove
                          </Button>
                        )}
                      </div>
                    ) : isAssigningThis ? (
                      <div className="space-y-2">
                        <Select value={keyCallSelectedComm} onValueChange={setKeyCallSelectedComm}>
                          <SelectTrigger className="h-7 text-xs" data-testid={`select-key-call-comm-${id}`}>
                            <SelectValue placeholder="Select recording..." />
                          </SelectTrigger>
                          <SelectContent>
                            {(clientComms || []).map((c: CommRecord) => (
                              <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                            ))}
                            {(unmatchedZoomComms || []).length > 0 && (
                              <div className="px-2 py-1 text-caption uppercase tracking-wide text-muted-foreground/70 border-t mt-1">Unassigned recordings</div>
                            )}
                            {(unmatchedZoomComms || []).filter((c: CommRecord) => c.isPendingReview).length > 0 && (
                              <div className="px-2 py-0.5 text-caption uppercase tracking-wide text-status-warn" data-testid="subheader-pending-review-key-call">Pending agent review</div>
                            )}
                            {(unmatchedZoomComms || []).filter((c: CommRecord) => c.isPendingReview).map((c: CommRecord) => (
                              <SelectItem key={`unassigned-${c.id}`} value={c.id} data-testid={`option-unmatched-key-call-${c.id}`}>
                                <UnmatchedZoomOptionLabel c={c} />
                              </SelectItem>
                            ))}
                            {(unmatchedZoomComms || []).filter((c: CommRecord) => !c.isPendingReview).length > 0 && (
                              <div className="px-2 py-0.5 text-caption uppercase tracking-wide text-muted-foreground/70" data-testid="subheader-never-matched-key-call">Never matched</div>
                            )}
                            {(unmatchedZoomComms || []).filter((c: CommRecord) => !c.isPendingReview).map((c: CommRecord) => (
                              <SelectItem key={`unassigned-${c.id}`} value={c.id} data-testid={`option-unmatched-key-call-${c.id}`}>
                                <UnmatchedZoomOptionLabel c={c} />
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="h-6 text-xs bg-primary hover:bg-primary/90 flex-1"
                            disabled={!keyCallSelectedComm || assignKeyCallMutation.isPending}
                            onClick={() => assignKeyCallMutation.mutate({ callType: id, rawCommunicationRecordId: keyCallSelectedComm })}
                            data-testid={`button-confirm-key-call-${id}`}
                          >
                            <Check className="w-3 h-3 mr-0.5" /> Assign
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setKeyCallAssigning(null); setKeyCallSelectedComm(""); }}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-2">
                        <p className="text-caption text-muted-foreground/70 mb-1">Not assigned</p>
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-caption border-primary/20 text-primary-ink"
                            onClick={() => { setKeyCallAssigning(id); setKeyCallSelectedComm(""); }}
                            data-testid={`button-assign-key-call-${id}`}
                          >
                            <Plus className="w-3 h-3 mr-0.5" /> Assign
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {isEditing("onboarding") ? (
              <div className="space-y-3 border-t pt-3 mt-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Onboarding Notes</Label>
                  <Textarea
                    value={editData.onboardingNotes || ""}
                    onChange={(e) => setEditData(prev => ({ ...prev, onboardingNotes: e.target.value }))}
                    className="text-sm min-h-[60px]"
                    placeholder="Key takeaways from onboarding, important context for the team..."
                    data-testid="input-onboarding-notes"
                  />
                </div>
                {renderEditActions("onboarding")}
              </div>
            ) : panel?.onboardingNotes ? (
              <div className="border-t pt-3 mt-3">
                {renderField("Onboarding Notes", panel.onboardingNotes)}
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* RER Recordings */}
      {panel && (
        <Card className="bg-card border-border" data-testid="card-rer-recordings">
          <CardHeader className="pb-3">
            <button
              type="button"
              className="w-full flex items-center justify-between"
              onClick={() => setRerExpanded(!rerExpanded)}
              data-testid="button-toggle-rer"
            >
              <CardTitle className="text-foreground text-sm flex items-center gap-2">
                <Calendar className="w-4 h-4" />
                RER Recordings
                {rerRecordings && rerRecordings.length > 0 && (
                  <Badge className="bg-primary/10 text-primary text-caption" data-testid="badge-rer-count">{rerRecordings.length}</Badge>
                )}
              </CardTitle>
              {rerExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground/70" /> : <ChevronDown className="w-4 h-4 text-muted-foreground/70" />}
            </button>
          </CardHeader>
          {rerExpanded && (
            <CardContent>
              <div className="space-y-2">
                {(!rerRecordings || rerRecordings.length === 0) && !rerAssigning && (
                  <p className="text-xs text-muted-foreground/70 text-center py-3" data-testid="text-no-rer">No RER recordings marked yet</p>
                )}
                {rerRecordings && rerRecordings.length > 0 && (
                  <div className="border rounded overflow-x-auto">
                    <table className="w-full text-xs min-w-[420px]">
                      <thead>
                        <tr className="bg-surface-warm-1/50 border-b">
                          <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Recording</th>
                          <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Month</th>
                          <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Date</th>
                          {canEdit && <th className="w-8"></th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rerRecordings.map((rer) => (
                          <tr key={rer.id} className="border-b last:border-0 hover:bg-muted/50" data-testid={`rer-row-${rer.id}`}>
                            <td className="py-1.5 px-2">
                              <button
                                className="text-primary-ink hover:underline truncate max-w-[200px] block text-left"
                                onClick={() => setRerDetailOpen(rer)}
                                data-testid={`button-view-rer-${rer.id}`}
                              >
                                {rer.communication?.title || "Unknown Recording"}
                              </button>
                            </td>
                            <td className="py-1.5 px-2 text-muted-foreground" data-testid={`text-rer-month-${rer.id}`}>{rer.reportingMonth}</td>
                            <td className="py-1.5 px-2 text-muted-foreground/70">
                              {rer.communication?.timestamp ? format(new Date(rer.communication.timestamp), "MMM d, yyyy") : "—"}
                            </td>
                            {canEdit && (
                              <td className="py-1.5 px-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-5 w-5 p-0"
                                  onClick={() => removeRerMutation.mutate(rer.id)}
                                  data-testid={`button-remove-rer-${rer.id}`}
                                >
                                  <Trash2 className="w-3 h-3 text-red-400" />
                                </Button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {rerAssigning ? (
                  <div className="border rounded-lg p-3 space-y-2 bg-surface-warm-1/30">
                    <div className="space-y-2">
                      <Select value={rerSelectedComm} onValueChange={setRerSelectedComm}>
                        <SelectTrigger className="h-7 text-xs" data-testid="select-rer-comm">
                          <SelectValue placeholder="Select recording..." />
                        </SelectTrigger>
                        <SelectContent>
                          {(clientComms || []).map((c: CommRecord) => (
                            <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                          ))}
                          {(unmatchedZoomComms || []).length > 0 && (
                            <div className="px-2 py-1 text-caption uppercase tracking-wide text-muted-foreground/70 border-t mt-1">Unassigned recordings</div>
                          )}
                          {(unmatchedZoomComms || []).filter((c: CommRecord) => c.isPendingReview).length > 0 && (
                            <div className="px-2 py-0.5 text-caption uppercase tracking-wide text-status-warn" data-testid="subheader-pending-review-rer">Pending agent review</div>
                          )}
                          {(unmatchedZoomComms || []).filter((c: CommRecord) => c.isPendingReview).map((c: CommRecord) => (
                            <SelectItem key={`unassigned-${c.id}`} value={c.id} data-testid={`option-unmatched-rer-${c.id}`}>
                              <UnmatchedZoomOptionLabel c={c} />
                            </SelectItem>
                          ))}
                          {(unmatchedZoomComms || []).filter((c: CommRecord) => !c.isPendingReview).length > 0 && (
                            <div className="px-2 py-0.5 text-caption uppercase tracking-wide text-muted-foreground/70" data-testid="subheader-never-matched-rer">Never matched</div>
                          )}
                          {(unmatchedZoomComms || []).filter((c: CommRecord) => !c.isPendingReview).map((c: CommRecord) => (
                            <SelectItem key={`unassigned-${c.id}`} value={c.id} data-testid={`option-unmatched-rer-${c.id}`}>
                              <UnmatchedZoomOptionLabel c={c} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={rerSelectedMonth}
                        onChange={(e) => setRerSelectedMonth(e.target.value)}
                        placeholder="e.g. 2026-03 or March 2026"
                        className="h-7 text-xs"
                        data-testid="input-rer-month"
                      />
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        className="h-6 text-xs bg-primary hover:bg-primary/90 flex-1"
                        disabled={!rerSelectedComm || !rerSelectedMonth || assignRerMutation.isPending}
                        onClick={() => assignRerMutation.mutate({ rawCommunicationRecordId: rerSelectedComm, reportingMonth: rerSelectedMonth })}
                        data-testid="button-confirm-rer"
                      >
                        <Check className="w-3 h-3 mr-0.5" /> Add RER
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setRerAssigning(false); setRerSelectedComm(""); setRerSelectedMonth(""); }} data-testid="button-cancel-rer">
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ) : canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-primary/20 text-primary-ink w-full"
                    onClick={() => setRerAssigning(true)}
                    data-testid="button-add-rer"
                  >
                    <Plus className="w-3 h-3 mr-1" /> Mark Recording as RER
                  </Button>
                )}
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Strategic Direction */}
      <Card className="bg-card border-border" data-testid="card-strategic-direction">
        <CardHeader className="pb-3">
          {renderSectionHeader("Strategic Direction", <Target className="w-4 h-4" />, "strategy")}
        </CardHeader>
        <CardContent>
          {isEditing("strategy") ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs text-muted-foreground">Annual Revenue Goal</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    value={editData.annualRevenueGoal || ""}
                    onChange={(e) => setEditData(prev => ({ ...prev, annualRevenueGoal: parseFloat(e.target.value) || null }))}
                    className="h-8 text-sm pl-7"
                    placeholder="e.g. 500000"
                    data-testid="input-annual-revenue-goal"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Current Quarter Objective(s)</Label>
                <Textarea
                  value={editData.quarterPrimaryObjective || ""}
                  onChange={(e) => setEditData(prev => ({ ...prev, quarterPrimaryObjective: e.target.value }))}
                  className="text-sm min-h-[60px]"
                  data-testid="input-quarter-objective"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Client-Approved Territory</Label>
                <Input
                  value={editData.approvedTerritory || ""}
                  onChange={(e) => setEditData(prev => ({ ...prev, approvedTerritory: e.target.value }))}
                  placeholder="e.g. Statewide TX, TX + OK, DFW metro only..."
                  className="h-8 text-sm"
                  data-testid="input-approved-territory"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Primary Markets (ranked)</Label>
                <div className="space-y-1 mt-1">
                  {(editData.priorityMarkets || []).map((market: string, idx: number) => (
                    <div key={idx} className="flex items-center gap-2 bg-surface-warm-1 rounded px-2 py-1.5" data-testid={`priority-market-${idx}`}>
                      <GripVertical className="w-3.5 h-3.5 text-muted-foreground/70" />
                      <span className="text-xs font-medium text-foreground w-5">{idx + 1}.</span>
                      <span className="text-sm flex-1">{safeDisplayString(market)}</span>
                      <div className="flex gap-0.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => moveMarket("up", idx)}
                          disabled={idx === 0}
                          data-testid={`button-market-up-${idx}`}
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0"
                          onClick={() => moveMarket("down", idx)}
                          disabled={idx === (editData.priorityMarkets || []).length - 1}
                          data-testid={`button-market-down-${idx}`}
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-red-500"
                          onClick={() => setEditData(prev => ({
                            ...prev,
                            priorityMarkets: (prev.priorityMarkets || []).filter((_: string, i: number) => i !== idx),
                          }))}
                          data-testid={`button-market-remove-${idx}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <Input
                    value={newMarketInput}
                    onChange={(e) => setNewMarketInput(e.target.value)}
                    placeholder="Add a primary market..."
                    className="h-8 text-sm flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newMarketInput.trim()) {
                        e.preventDefault();
                        setEditData(prev => ({
                          ...prev,
                          priorityMarkets: [...(prev.priorityMarkets || []), newMarketInput.trim()],
                        }));
                        setNewMarketInput("");
                      }
                    }}
                    data-testid="input-add-priority-market"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => {
                      if (newMarketInput.trim()) {
                        setEditData(prev => ({
                          ...prev,
                          priorityMarkets: [...(prev.priorityMarkets || []), newMarketInput.trim()],
                        }));
                        setNewMarketInput("");
                      }
                    }}
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Secondary Markets (ranked)</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={newSecondaryMarketInput}
                    onChange={(e) => setNewSecondaryMarketInput(e.target.value)}
                    placeholder="Add a secondary market..."
                    className="h-8 text-sm flex-1"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newSecondaryMarketInput.trim()) {
                        e.preventDefault();
                        setEditData(prev => ({
                          ...prev,
                          secondaryMarkets: [...(prev.secondaryMarkets || []), newSecondaryMarketInput.trim()],
                        }));
                        setNewSecondaryMarketInput("");
                      }
                    }}
                    data-testid="input-add-secondary-market"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => {
                      if (newSecondaryMarketInput.trim()) {
                        setEditData(prev => ({
                          ...prev,
                          secondaryMarkets: [...(prev.secondaryMarkets || []), newSecondaryMarketInput.trim()],
                        }));
                        setNewSecondaryMarketInput("");
                      }
                    }}
                  >
                    <Plus className="w-3 h-3" />
                  </Button>
                </div>
                {(editData.secondaryMarkets || []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(editData.secondaryMarkets || []).map((m: string, i: number) => (
                      <Badge key={i} variant="secondary" className="text-xs">
                        {safeDisplayString(m)}
                        <button className="ml-1" onClick={() => setEditData(prev => ({
                          ...prev,
                          secondaryMarkets: (prev.secondaryMarkets || []).filter((_: string, idx: number) => idx !== i),
                        }))}>
                          <X className="w-3 h-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Geographic Expansion Notes</Label>
                <Textarea
                  value={editData.geographicExpansionNotes || ""}
                  onChange={(e) => setEditData(prev => ({ ...prev, geographicExpansionNotes: e.target.value }))}
                  className="text-sm min-h-[60px]"
                  data-testid="input-geo-expansion-notes"
                />
              </div>
              {renderEditActions("strategy")}
            </div>
          ) : (
            <div className="space-y-3">
              {panel?.annualRevenueGoal && renderField("Annual Revenue Goal", panel.annualRevenueGoal, "currency")}
              {renderField("Current Quarter Objective(s)", panel?.quarterPrimaryObjective)}
              {panel?.approvedTerritory && (
                <div className="p-3 bg-emerald-50/50 border border-emerald-200/50 rounded-lg" data-testid="display-approved-territory">
                  <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide flex items-center gap-1 mb-1">
                    <Shield className="w-3 h-3" />
                    Client-Approved Territory
                  </p>
                  <p className="text-sm font-medium text-foreground">{panel.approvedTerritory}</p>
                </div>
              )}
              {(panel?.priorityMarkets || []).length > 0 ? (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Primary Markets (ranked)</p>
                  <div className="space-y-1">
                    {(panel?.priorityMarkets as any[])!.map((m: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-sm" data-testid={`text-priority-market-${i}`}>
                        <span className="text-xs font-semibold text-primary dark:text-foreground bg-surface-warm-1 rounded-full w-5 h-5 flex items-center justify-center">{i + 1}</span>
                        {safeDisplayString(m)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : renderField("Primary Markets", null)}
              {renderField("Secondary Markets", panel?.secondaryMarkets || [], "list")}
              {panel?.geographicExpansionNotes && renderField("Expansion Notes", panel.geographicExpansionNotes)}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Products & Budget */}
      <Card
        className="bg-card border-border"
        data-testid="card-products-budgets-standalone"
        // Task #4038: register the Products & Budget card so highlightField
        // values pointing at product/budget fields scroll + flash it (e.g.
        // the client list's "Budget missing" badge links here).
        ref={(el) => {
          sectionRefs.current["productTypes"] = el;
          sectionRefs.current["lsaBudget"] = el;
          sectionRefs.current["googleAdsBudget"] = el;
          sectionRefs.current["webinarBudget"] = el;
        }}
      >
        <CardHeader className="pb-3">
          {renderSectionHeader("Products & Budget", <Package className="w-4 h-4" />, "products")}
        </CardHeader>
        <CardContent className="space-y-3">
          {isEditing("products") ? (
            <>
              <div>
                <Label className="text-xs text-muted-foreground">Active Products</Label>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {PRODUCT_OPTIONS.map(opt => (
                    <label key={opt.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={(editData.productTypes || []).includes(opt.id)}
                        onCheckedChange={(checked) => {
                          const current = editData.productTypes || [];
                          setEditData(prev => ({
                            ...prev,
                            productTypes: checked
                              ? [...current, opt.id]
                              : current.filter((p: string) => p !== opt.id),
                          }));
                        }}
                        data-testid={`checkbox-product-${opt.id}`}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Product Status Notes</Label>
                <Input
                  value={editData.productStatusNotes || ""}
                  onChange={(e) => setEditData(prev => ({ ...prev, productStatusNotes: e.target.value }))}
                  className="h-8 text-sm"
                  data-testid="input-product-status-notes"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Current Bottleneck</Label>
                  <Select
                    value={
                      !editData.currentBottleneck ? "none"
                        : BOTTLENECK_OPTIONS.some(o => o.id === editData.currentBottleneck) ? editData.currentBottleneck
                        : editData.currentBottleneck.startsWith("other:") ? "other"
                        : "other"
                    }
                    onValueChange={(val) => {
                      if (val === "none") {
                        setEditData(prev => ({ ...prev, currentBottleneck: null }));
                      } else if (val === "other") {
                        setEditData(prev => ({ ...prev, currentBottleneck: "other:" }));
                      } else {
                        setEditData(prev => ({ ...prev, currentBottleneck: val }));
                      }
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-bottleneck">
                      <SelectValue placeholder="Select bottleneck" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {BOTTLENECK_OPTIONS.map(opt => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editData.currentBottleneck && (editData.currentBottleneck === "other" || editData.currentBottleneck.startsWith("other:")) && (
                    <Input
                      value={editData.currentBottleneck.startsWith("other:") ? editData.currentBottleneck.slice(6) : ""}
                      onChange={(e) => setEditData(prev => ({ ...prev, currentBottleneck: "other:" + e.target.value }))}
                      placeholder="Describe the bottleneck..."
                      className="h-8 text-sm mt-2"
                      data-testid="input-bottleneck-other"
                    />
                  )}
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Budget Posture</Label>
                  <Select
                    value={editData.budgetPosture || "none"}
                    onValueChange={(val) => setEditData(prev => ({ ...prev, budgetPosture: val === "none" ? null : val }))}
                  >
                    <SelectTrigger className="h-8 text-sm" data-testid="select-budget-posture">
                      <SelectValue placeholder="Select posture" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {BUDGET_POSTURE_OPTIONS.map(opt => (
                        <SelectItem key={opt.id} value={opt.id}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {(editData.productTypes || []).includes("lsa") && (
                <div className="space-y-3 p-3 bg-amber-50/50 border border-amber-200/50 rounded-lg">
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide flex items-center gap-1">
                    LSA
                  </p>
                  <div>
                    <Label className="text-xs text-muted-foreground">Budget</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        type="number"
                        value={editData.lsaBudget || ""}
                        onChange={(e) => setEditData(prev => ({ ...prev, lsaBudget: parseFloat(e.target.value) || null }))}
                        className="h-8 text-sm pl-7"
                        data-testid="input-lsa-budget"
                      />
                    </div>
                  </div>
                </div>
              )}
              {(editData.productTypes || []).includes("google_ads") && (
                <div className="space-y-3 p-3 bg-blue-50/50 border border-blue-200/50 rounded-lg">
                  <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    Google Ads
                  </p>
                  <div>
                    <Label className="text-xs text-muted-foreground">Budget *</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        type="number"
                        value={editData.googleAdsBudget || ""}
                        onChange={(e) => setEditData(prev => ({ ...prev, googleAdsBudget: parseFloat(e.target.value) || null }))}
                        className="h-8 text-sm pl-7"
                        data-testid="input-google-ads-budget"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Active Target Areas</Label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(editData.googleAdsTargetAreas || []).map((area: string, i: number) => (
                        <Badge key={i} variant="secondary" className="text-xs bg-blue-100 text-blue-800">
                          {area}
                          <button className="ml-1" onClick={() => setEditData(prev => ({
                            ...prev,
                            googleAdsTargetAreas: (prev.googleAdsTargetAreas || []).filter((_: string, idx: number) => idx !== i),
                          }))} data-testid={`button-remove-gads-area-${i}`}>
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <Input
                      placeholder="Add a target area (e.g. Dallas 25mi)..."
                      className="h-8 text-sm mt-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                          e.preventDefault();
                          const val = (e.target as HTMLInputElement).value.trim();
                          setEditData(prev => ({
                            ...prev,
                            googleAdsTargetAreas: [...(prev.googleAdsTargetAreas || []), val],
                          }));
                          (e.target as HTMLInputElement).value = "";
                        }
                      }}
                      data-testid="input-add-gads-target-area"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Targeting Method</Label>
                    <Select
                      value={editData.googleAdsTargetingMethod || ""}
                      onValueChange={(v) => setEditData(prev => ({ ...prev, googleAdsTargetingMethod: v }))}
                    >
                      <SelectTrigger className="h-8 text-sm" data-testid="select-gads-targeting-method">
                        <SelectValue placeholder="Select method..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="radius">Radius</SelectItem>
                        <SelectItem value="city">City</SelectItem>
                        <SelectItem value="dma">DMA</SelectItem>
                        <SelectItem value="zip_codes">Zip Codes</SelectItem>
                        <SelectItem value="statewide">Statewide</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Excluded Areas</Label>
                    <Input
                      value={editData.googleAdsExcludedAreas || ""}
                      onChange={(e) => setEditData(prev => ({ ...prev, googleAdsExcludedAreas: e.target.value }))}
                      placeholder="e.g. El Paso, Lubbock"
                      className="h-8 text-sm"
                      data-testid="input-gads-excluded-areas"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Geo Notes</Label>
                    <Input
                      value={editData.googleAdsGeoNotes || ""}
                      onChange={(e) => setEditData(prev => ({ ...prev, googleAdsGeoNotes: e.target.value }))}
                      placeholder="Rationale for current targeting..."
                      className="h-8 text-sm"
                      data-testid="input-gads-geo-notes"
                    />
                  </div>
                </div>
              )}
              {(editData.productTypes || []).includes("webinar") && (
                <div className="space-y-3 p-3 bg-purple-50/50 border border-purple-200/50 rounded-lg">
                  <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide flex items-center gap-1">
                    <Video className="w-3 h-3" />
                    Webinars (Virtual)
                  </p>
                  <div>
                    <Label className="text-xs text-muted-foreground">Budget *</Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        type="number"
                        value={editData.webinarBudget || ""}
                        onChange={(e) => setEditData(prev => ({ ...prev, webinarBudget: parseFloat(e.target.value) || null }))}
                        className="h-8 text-sm pl-7"
                        data-testid="input-webinar-budget"
                      />
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Active Target Areas</Label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {(editData.webinarTargetAreas || []).map((area: string, i: number) => (
                        <Badge key={i} variant="secondary" className="text-xs bg-purple-100 text-purple-800">
                          {area}
                          <button className="ml-1" onClick={() => setEditData(prev => ({
                            ...prev,
                            webinarTargetAreas: (prev.webinarTargetAreas || []).filter((_: string, idx: number) => idx !== i),
                          }))} data-testid={`button-remove-webinar-area-${i}`}>
                            <X className="w-3 h-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <Input
                      placeholder="Add a target area (e.g. Statewide TX)..."
                      className="h-8 text-sm mt-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.target as HTMLInputElement).value.trim()) {
                          e.preventDefault();
                          const val = (e.target as HTMLInputElement).value.trim();
                          setEditData(prev => ({
                            ...prev,
                            webinarTargetAreas: [...(prev.webinarTargetAreas || []), val],
                          }));
                          (e.target as HTMLInputElement).value = "";
                        }
                      }}
                      data-testid="input-add-webinar-target-area"
                    />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Geo Notes</Label>
                    <Input
                      value={editData.webinarGeoNotes || ""}
                      onChange={(e) => setEditData(prev => ({ ...prev, webinarGeoNotes: e.target.value }))}
                      placeholder="Coverage rationale..."
                      className="h-8 text-sm"
                      data-testid="input-webinar-geo-notes"
                    />
                  </div>
                </div>
              )}
              {(editData.productTypes || []).includes("gbp") && (
                <div className="space-y-3 p-3 bg-green-50/50 border border-green-200/50 rounded-lg" data-testid="gbp-locations-section">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-green-700 uppercase tracking-wide flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      GBP Locations ({gbpLocations?.length || 0})
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-caption border-green-300 text-green-700 hover:bg-green-100"
                      onClick={() => { setShowGbpLocationForm(true); setEditingGbpLocationId(null); setGbpLocationForm({ name: "", address: "" }); setGbpLocationError(""); }}
                      data-testid="button-add-gbp-location"
                    >
                      <Plus className="w-3 h-3 mr-0.5" />
                      Add
                    </Button>
                  </div>
                  <p className="text-caption text-muted-foreground">Each location requires a valid street address for MCU capacity analysis</p>
                  {showGbpLocationForm && (
                    <div className="p-3 border border-green-200 rounded-lg bg-card space-y-2">
                      <div>
                        <Label className="text-xs text-muted-foreground">Location Name *</Label>
                        <Input
                          placeholder="e.g., Downtown Office"
                          value={gbpLocationForm.name}
                          onChange={(e) => setGbpLocationForm(prev => ({ ...prev, name: e.target.value }))}
                          className="h-8 text-sm"
                          data-testid="input-gbp-location-name"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Full Address *</Label>
                        <Input
                          placeholder="123 Main St, Dallas, TX 75201"
                          value={gbpLocationForm.address}
                          onChange={(e) => setGbpLocationForm(prev => ({ ...prev, address: e.target.value }))}
                          className="h-8 text-sm"
                          data-testid="input-gbp-location-address"
                        />
                      </div>
                      {gbpLocationError && <p className="text-xs text-red-600" data-testid="text-gbp-location-error">{gbpLocationError}</p>}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="bg-green-700 hover:bg-green-800 h-7 text-xs"
                          onClick={() => { setGbpLocationError(""); createGbpLocationMutation.mutate(gbpLocationForm); }}
                          disabled={!gbpLocationForm.name.trim() || !gbpLocationForm.address.trim() || createGbpLocationMutation.isPending}
                          data-testid="button-save-gbp-location"
                        >
                          {createGbpLocationMutation.isPending ? "Validating..." : "Save Location"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => { setShowGbpLocationForm(false); setGbpLocationForm({ name: "", address: "" }); setGbpLocationError(""); }}
                          data-testid="button-cancel-gbp-location"
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {!gbpLocations || gbpLocations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No locations added yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {gbpLocations.map(loc => (
                        <div key={loc.id} className="p-2.5 bg-card rounded-lg border border-green-100" data-testid={`gbp-location-${loc.id}`}>
                          {editingGbpLocationId === loc.id ? (
                            <div className="space-y-2">
                              <div>
                                <Label className="text-xs text-muted-foreground">Location Name *</Label>
                                <Input
                                  value={gbpLocationForm.name}
                                  onChange={(e) => setGbpLocationForm(prev => ({ ...prev, name: e.target.value }))}
                                  className="h-8 text-sm"
                                  data-testid={`input-edit-gbp-location-name-${loc.id}`}
                                />
                              </div>
                              <div>
                                <Label className="text-xs text-muted-foreground">Full Address *</Label>
                                <Input
                                  value={gbpLocationForm.address}
                                  onChange={(e) => setGbpLocationForm(prev => ({ ...prev, address: e.target.value }))}
                                  className="h-8 text-sm"
                                  data-testid={`input-edit-gbp-location-address-${loc.id}`}
                                />
                              </div>
                              {gbpLocationError && <p className="text-xs text-red-600" data-testid="text-gbp-location-error">{gbpLocationError}</p>}
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="bg-green-700 hover:bg-green-800 h-7 text-xs"
                                  onClick={() => { setGbpLocationError(""); updateGbpLocationMutation.mutate({ locationId: loc.id, data: gbpLocationForm }); }}
                                  disabled={!gbpLocationForm.name.trim() || !gbpLocationForm.address.trim() || updateGbpLocationMutation.isPending}
                                  data-testid={`button-save-edit-gbp-location-${loc.id}`}
                                >
                                  {updateGbpLocationMutation.isPending ? "Validating..." : "Save Changes"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() => { setEditingGbpLocationId(null); setGbpLocationForm({ name: "", address: "" }); setGbpLocationError(""); }}
                                  data-testid={`button-cancel-edit-gbp-location-${loc.id}`}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start justify-between">
                              <div className="flex-1">
                                <p className="font-medium text-xs text-foreground">{loc.name}</p>
                                {loc.address && <p className="text-caption text-muted-foreground">{loc.address}</p>}
                                {loc.city && loc.state && (
                                  <p className="text-caption text-green-600 mt-0.5 flex items-center gap-0.5">
                                    <CheckCircle className="w-2.5 h-2.5" />
                                    Geocoded: {loc.city}, {loc.state}
                                  </p>
                                )}
                                {!loc.lat && loc.address && (
                                  <p className="text-caption text-yellow-600 mt-0.5 flex items-center gap-0.5">
                                    <AlertTriangle className="w-2.5 h-2.5" />
                                    Not geocoded
                                  </p>
                                )}
                                <div className="mt-1">
                                  <LocationAuditInfo
                                    clientId={clientId}
                                    locationId={loc.id}
                                    locationName={loc.name}
                                    audit={locationAuditByLocation.get(String(loc.id))}
                                  />
                                </div>
                              </div>
                              <div className="flex gap-0.5">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-green-700 hover:bg-green-50 h-6 w-6 p-0"
                                  onClick={() => {
                                    setEditingGbpLocationId(loc.id);
                                    setGbpLocationForm({ name: loc.name, address: loc.address || "" });
                                    setGbpLocationError("");
                                    setShowGbpLocationForm(false);
                                  }}
                                  data-testid={`button-edit-gbp-location-${loc.id}`}
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <ConfirmActionDialog
                                  title={`Delete "${loc.name}"?`}
                                  description="The GBP location is removed from this client's command panel immediately. Reports that reference it keep their saved data, but new reports can no longer pick it. This cannot be undone."
                                  confirmLabel="Delete location"
                                  testId={`dialog-confirm-delete-gbp-location-${loc.id}`}
                                  onConfirm={() => deleteGbpLocationMutation.mutate(loc.id)}
                                  trigger={
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="text-red-500 hover:text-red-700 hover:bg-red-50 h-6 w-6 p-0"
                                      disabled={deleteGbpLocationMutation.isPending}
                                      data-testid={`button-delete-gbp-location-${loc.id}`}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  }
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {renderEditActions("products")}
            </>
          ) : (
            <>
              {renderField("Products", panelProducts.map(p => PRODUCT_OPTIONS.find(o => o.id === p)?.label || p), "list")}
              {panel?.productStatusNotes && renderField("Status Notes", panel.productStatusNotes)}
              <div className="grid grid-cols-2 gap-3">
                {renderField("Current Bottleneck",
                  panel?.currentBottleneck
                    ? panel.currentBottleneck.startsWith("other:")
                      ? "Other: " + panel.currentBottleneck.slice(6)
                      : BOTTLENECK_OPTIONS.find(o => o.id === panel.currentBottleneck)?.label || panel.currentBottleneck
                    : null
                )}
                {renderField("Budget Posture",
                  panel?.budgetPosture
                    ? BUDGET_POSTURE_OPTIONS.find(o => o.id === panel.budgetPosture)?.label || panel.budgetPosture
                    : null
                )}
              </div>
              {panelProducts.includes("lsa") && (
                <div className="p-3 bg-amber-50/50 border border-amber-200/50 rounded-lg space-y-2" data-testid="display-lsa-budget">
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide">LSA</p>
                  {renderField("Budget", panel?.lsaBudget ?? null, "currency")}
                  {panel?.lsaBudget == null && renderMissingBudgetNotice("lsa", "LSA")}
                </div>
              )}
              {panelProducts.includes("google_ads") && (
                <div className="p-3 bg-blue-50/50 border border-blue-200/50 rounded-lg space-y-2" data-testid="display-google-ads-targeting">
                  <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    Google Ads
                  </p>
                  {renderField("Budget", panel?.googleAdsBudget, "currency")}
                  {panel?.googleAdsBudget == null && renderMissingBudgetNotice("google_ads", "Google Ads")}
                  {(panel?.googleAdsTargetAreas || []).length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Target Areas</p>
                      <div className="flex flex-wrap gap-1">
                        {(panel?.googleAdsTargetAreas || []).map((area: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs bg-blue-100 text-blue-800" data-testid={`text-gads-area-${i}`}>{area}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {panel?.googleAdsTargetingMethod && renderField("Method", panel.googleAdsTargetingMethod === "zip_codes" ? "Zip Codes" : panel.googleAdsTargetingMethod.charAt(0).toUpperCase() + panel.googleAdsTargetingMethod.slice(1))}
                  {panel?.googleAdsExcludedAreas && renderField("Excluded", panel.googleAdsExcludedAreas)}
                  {panel?.googleAdsGeoNotes && renderField("Notes", panel.googleAdsGeoNotes)}
                </div>
              )}
              {panelProducts.includes("webinar") && (
                <div className="p-3 bg-purple-50/50 border border-purple-200/50 rounded-lg space-y-2" data-testid="display-webinar-targeting">
                  <p className="text-xs font-semibold text-purple-700 uppercase tracking-wide flex items-center gap-1">
                    <Video className="w-3 h-3" />
                    Webinars
                  </p>
                  {renderField("Budget", panel?.webinarBudget, "currency")}
                  {panel?.webinarBudget == null && renderMissingBudgetNotice("webinar", "Webinars")}
                  {(panel?.webinarTargetAreas || []).length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Target Areas</p>
                      <div className="flex flex-wrap gap-1">
                        {(panel?.webinarTargetAreas || []).map((area: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs bg-purple-100 text-purple-800" data-testid={`text-webinar-area-${i}`}>{area}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                  {panel?.webinarGeoNotes && renderField("Notes", panel.webinarGeoNotes)}
                </div>
              )}
              {panelProducts.includes("gbp") && (
                <div className="p-3 bg-green-50/50 border border-green-200/50 rounded-lg space-y-2" data-testid="display-gbp-locations">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-green-700 uppercase tracking-wide flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      GBP Locations ({gbpLocations?.length || 0})
                    </p>
                  </div>
                  {!gbpLocations || gbpLocations.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No locations added yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {gbpLocations.map(loc => (
                        <div key={loc.id} className="p-2 bg-card rounded border border-green-100" data-testid={`display-gbp-location-${loc.id}`}>
                          <p className="font-medium text-xs text-foreground">{loc.name}</p>
                          {loc.address && <p className="text-caption text-muted-foreground">{loc.address}</p>}
                          {loc.city && loc.state && (
                            <p className="text-caption text-green-600 mt-0.5 flex items-center gap-0.5">
                              <CheckCircle className="w-2.5 h-2.5" />
                              Geocoded: {loc.city}, {loc.state}
                            </p>
                          )}
                          {!loc.lat && loc.address && (
                            <p className="text-caption text-yellow-600 mt-0.5 flex items-center gap-0.5">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              Not geocoded
                            </p>
                          )}
                          <div className="mt-1">
                            <LocationAuditInfo
                              clientId={clientId}
                              locationId={loc.id}
                              locationName={loc.name}
                              audit={locationAuditByLocation.get(String(loc.id))}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Data Access */}
      <Card className="bg-card border-border" data-testid="card-data-access">
        <CardHeader className="pb-3">
          {renderSectionHeader("Data Access", <Shield className="w-4 h-4" />, "data-access")}
          <p className="text-xs text-muted-foreground">What data does this client provide access to?</p>
        </CardHeader>
        <CardContent>
          {isEditing("data-access") ? (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {DATA_ACCESS_CATEGORIES.map(cat => (
                  <div key={cat.id} className="p-3 bg-surface-warm-1 rounded-lg space-y-2">
                    <div>
                      <p className="font-medium text-sm text-foreground">{cat.label}</p>
                      <p className="text-xs text-muted-foreground">{cat.description}</p>
                    </div>
                    <Select
                      value={dataAccessDraft[cat.id] || "unknown"}
                      onValueChange={v => setDataAccessDraft(prev => ({ ...prev, [cat.id]: v }))}
                    >
                      <SelectTrigger className="h-8 text-xs" data-testid={`select-access-${cat.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="available">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-green-500" />
                            Available
                          </span>
                        </SelectItem>
                        <SelectItem value="pending">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-yellow-500" />
                            Pending
                          </span>
                        </SelectItem>
                        <SelectItem value="refused">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-red-500" />
                            Refused
                          </span>
                        </SelectItem>
                        <SelectItem value="unknown">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-gray-400" />
                            Unknown
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
              {renderEditActions("data-access")}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {DATA_ACCESS_CATEGORIES.map(cat => {
                const currentStatus = dataAccess?.find((d: DataAccessEntry) => d.category === cat.id)?.status || "unknown";
                const statusConfig: Record<string, { color: string; label: string }> = {
                  available: { color: "bg-green-500", label: "Available" },
                  pending: { color: "bg-yellow-500", label: "Pending" },
                  refused: { color: "bg-red-500", label: "Refused" },
                  unknown: { color: "bg-gray-400", label: "Unknown" },
                };
                const config = statusConfig[currentStatus] || statusConfig.unknown;
                const dataDetected =
                  currentStatus !== "available" &&
                  dataAccessDetection?.[cat.id] === "present";
                return (
                  <div key={cat.id} className="p-3 bg-surface-warm-1/60 rounded-lg">
                    <p className="font-medium text-sm text-foreground">{cat.label}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`w-2 h-2 rounded-full ${config.color}`} />
                      <span className="text-xs text-muted-foreground">{config.label}</span>
                    </div>
                    {dataDetected && (
                      <p
                        className="text-caption text-amber-700 mt-1 flex items-center gap-1"
                        data-testid={`hint-data-detected-${cat.id}`}
                      >
                        <Sparkles className="w-3 h-3" />
                        Data detected — consider marking Available
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Custom Terminology */}
      <Card className="bg-card border-border" data-testid="card-terminology">
        <CardHeader className="pb-3">
          {renderSectionHeader("Custom Terminology", <FileText className="w-4 h-4" />, "terminology")}
          <p className="text-xs text-muted-foreground">Override default terms used in reports and analytics for this client.</p>
        </CardHeader>
        <CardContent>
          {isEditing("terminology") ? (
            <div className="space-y-3">
              <div className="border rounded-lg overflow-x-auto">
                <table className="w-full text-sm min-w-[400px]">
                  <thead>
                    <tr className="bg-surface-warm-1">
                      <th className="text-left p-3 font-medium text-foreground">Default Term</th>
                      <th className="text-left p-3 font-medium text-foreground">Custom Override</th>
                    </tr>
                  </thead>
                  <tbody>
                    {terminologyKeys.map((key) => (
                      <tr key={key} className="border-t border-border">
                        <td className="p-3 text-muted-foreground">{terminologyDefaults[key]}</td>
                        <td className="p-3">
                          <Input
                            placeholder={terminologyDefaults[key]}
                            value={(editData[key] as string) || ""}
                            onChange={(e) => setEditData(prev => ({ ...prev, [key]: e.target.value }))}
                            className="h-8 text-sm"
                            data-testid={`input-terminology-${key}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {renderEditActions("terminology")}
            </div>
          ) : terminologyKeys.some((key) => (client.terminology?.[key] ?? "").trim()) ? (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[400px]">
                <thead>
                  <tr className="bg-surface-warm-1">
                    <th className="text-left p-3 font-medium text-foreground">Default Term</th>
                    <th className="text-left p-3 font-medium text-foreground">Custom Override</th>
                  </tr>
                </thead>
                <tbody>
                  {terminologyKeys.map((key) => {
                    const currentOverride = client.terminology?.[key] || "";
                    return (
                      <tr key={key} className="border-t border-border">
                        <td className="p-3 text-muted-foreground">{terminologyDefaults[key]}</td>
                        <td className="p-3 text-sm font-medium">{currentOverride || <span className="text-muted-foreground/70">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            /* Task #4349 (P3-5) — with zero overrides the full table is an
               all-"—" wall that reads broken; collapse to a compact note. The
               table (and edit mode via the header pencil) return as soon as
               an override exists. */
            <p className="text-sm text-muted-foreground/70" data-testid="text-terminology-unset">
              No custom terms set — reports and analytics use the defaults
              ({terminologyKeys.map((key) => terminologyDefaults[key]).join(" · ")}).
            </p>
          )}
        </CardContent>
      </Card>

      {/* Key Call Detail Dialog */}
      <Dialog open={!!keyCallDetailOpen} onOpenChange={() => setKeyCallDetailOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">{keyCallDetailOpen?.communication?.title || "Recording Details"}</DialogTitle>
          </DialogHeader>
          {keyCallDetailOpen?.communication && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>{keyCallDetailOpen.communication.sourceType}</span>
                {keyCallDetailOpen.communication.timestamp && (
                  <span>{format(new Date(keyCallDetailOpen.communication.timestamp), "MMM d, yyyy h:mm a")}</span>
                )}
              </div>
              {keyCallDetailOpen.communication.aiSummary && (
                <div className="p-3 bg-purple-50 border border-purple-100 rounded">
                  <div className="flex items-center gap-1 text-purple-700 font-medium text-sm mb-1">
                    <Sparkles className="w-3.5 h-3.5" /> AI Summary
                  </div>
                  <p className="text-sm text-purple-900 whitespace-pre-wrap">{keyCallDetailOpen.communication.aiSummary}</p>
                </div>
              )}
              {keyCallDetailOpen.communication.contentText && (
                <div className="p-3 bg-muted/50 border border-border rounded max-h-96 overflow-y-auto">
                  <p className="text-sm text-muted-foreground font-medium mb-2">Transcript</p>
                  <pre className="text-sm text-foreground whitespace-pre-wrap font-sans">{keyCallDetailOpen.communication.contentText}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* RER Detail Dialog */}
      <Dialog open={!!rerDetailOpen} onOpenChange={() => setRerDetailOpen(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">{rerDetailOpen?.communication?.title || "RER Recording"}</DialogTitle>
          </DialogHeader>
          {rerDetailOpen?.communication && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className="text-xs">{rerDetailOpen.reportingMonth}</Badge>
                {rerDetailOpen.communication.timestamp && (
                  <span>{format(new Date(rerDetailOpen.communication.timestamp), "MMM d, yyyy h:mm a")}</span>
                )}
              </div>
              {rerDetailOpen.communication.aiSummary && (
                <div className="p-3 bg-purple-50 border border-purple-100 rounded">
                  <div className="flex items-center gap-1 text-purple-700 font-medium text-sm mb-1">
                    <Sparkles className="w-3.5 h-3.5" /> AI Summary
                  </div>
                  <p className="text-sm text-purple-900 whitespace-pre-wrap">{rerDetailOpen.communication.aiSummary}</p>
                </div>
              )}
              {rerDetailOpen.communication.contentText && (
                <div className="p-3 bg-muted/50 border border-border rounded max-h-96 overflow-y-auto">
                  <p className="text-sm text-muted-foreground font-medium mb-2">Transcript</p>
                  <pre className="text-sm text-foreground whitespace-pre-wrap font-sans">{rerDetailOpen.communication.contentText}</pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Document Picker Dialog */}
      <Dialog open={contractPickerOpen} onOpenChange={(open) => { setContractPickerOpen(open); if (!open) setContractSearch(""); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground">Link PandaDoc Document</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search documents..."
              value={contractSearch}
              onChange={(e) => setContractSearch(e.target.value)}
              className="pl-9"
              data-testid="input-contract-search"
            />
          </div>
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {!allPandadocDocs || allPandadocDocs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-documents">
                {contractSearch ? "No documents match your search" : "No PandaDoc documents found. Sync documents from the Integrations page first."}
              </p>
            ) : (
              allPandadocDocs.map((doc) => {
                const isLinked = doc.linkedClientId === clientId;
                const isLinkedElsewhere = doc.linkedClientId && doc.linkedClientId !== clientId;
                const statusLabel = doc.status.replace("document.", "").replace(/_/g, " ");
                return (
                  <div
                    key={doc.id}
                    className={`border rounded-lg p-3 transition-colors ${isLinked ? "bg-green-50 border-green-200" : isLinkedElsewhere ? "opacity-50" : "hover:bg-muted/50 cursor-pointer"}`}
                    data-testid={`picker-doc-${doc.id}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{doc.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className="text-caption px-1.5 py-0 capitalize">{statusLabel}</Badge>
                          {doc.createdDate && (
                            <span className="text-xs text-muted-foreground">{format(new Date(doc.createdDate), "MMM d, yyyy")}</span>
                          )}
                          {isLinkedElsewhere && <span className="text-xs text-amber-600">Linked to another client</span>}
                        </div>
                      </div>
                      {isLinked ? (
                        <Badge variant="outline" className="bg-green-100 text-green-700 text-xs">Linked</Badge>
                      ) : !isLinkedElsewhere ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => linkContractMutation.mutate(doc.id)}
                          disabled={linkContractMutation.isPending}
                          data-testid={`button-link-doc-${doc.id}`}
                        >
                          {linkContractMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Link"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Contract Detail Dialog */}
      <Dialog
        open={!!contractDetailOpen}
        onOpenChange={(open) => {
          if (!open) {
            setContractDetailOpen(null);
            setContractPdfError(null);
            setContractPdfDownloading(false);
            setContractPdfPreviewLoading(false);
            setContractPdfPreviewError(null);
            setContractPdfPreviewNotReady(false);
            setContractPdfPreviewDisconnected(false);
            setContractPdfPreviewUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return null;
            });
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5" />
              {contractDetail?.title || "Contract"}
            </DialogTitle>
          </DialogHeader>
          {contractDetail ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  disabled={!contractDetail.pandadocAppUrl}
                  data-testid="link-open-in-pandadoc"
                >
                  <a
                    href={contractDetail.pandadocAppUrl || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-disabled={!contractDetail.pandadocAppUrl}
                    onClick={(e) => { if (!contractDetail.pandadocAppUrl) e.preventDefault(); }}
                  >
                    <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                    Open in PandaDoc
                  </a>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={contractPdfDownloading}
                  data-testid="button-download-pdf"
                  onClick={async () => {
                    if (!contractDetail) return;
                    setContractPdfError(null);
                    setContractPdfDownloading(true);
                    try {
                      const res = await fetch(
                        `/api/integrations/pandadoc/documents/${contractDetail.id}/pdf`,
                        { credentials: "include" },
                      );
                      if (!res.ok) {
                        let message = "Could not download this contract right now.";
                        try {
                          const body = await res.json();
                          if (body?.error) message = String(body.error);
                        } catch {}
                        setContractPdfError(message);
                        toast({ title: "Download failed", description: message, variant: "destructive" });
                        return;
                      }
                      const blob = await res.blob();
                      const safeTitle = (contractDetail.title || "document")
                        .replace(/[\\/:*?"<>|\r\n]+/g, "_")
                        .replace(/\s+/g, " ")
                        .trim() || "document";
                      const filename = `${safeTitle}.pdf`;
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = filename;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    } catch (err: any) {
                      const message = err?.message || "Could not download this contract right now.";
                      setContractPdfError(message);
                      toast({ title: "Download failed", description: message, variant: "destructive" });
                    } finally {
                      setContractPdfDownloading(false);
                    }
                  }}
                >
                  {contractPdfDownloading ? (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                  )}
                  Download PDF
                </Button>
              </div>
              {contractPdfError && (
                <div
                  className="bg-red-50 border border-red-200 text-red-700 rounded-md px-3 py-2 text-xs"
                  data-testid="text-contract-pdf-error"
                >
                  {contractPdfError}
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Preview</p>
                <div
                  className="border border-border rounded-lg bg-muted/50 overflow-hidden"
                  style={{ height: "70vh", minHeight: 480 }}
                  data-testid="container-contract-pdf-preview"
                >
                  {contractPdfPreviewLoading ? (
                    <div className="h-full flex items-center justify-center" data-testid="status-contract-pdf-loading">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : contractPdfPreviewUrl ? (
                    <Suspense
                      fallback={
                        <div className="h-full flex items-center justify-center" data-testid="status-contract-pdf-engine-loading">
                          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                      }
                    >
                      <PdfPreviewWithSearch
                        fileUrl={contractPdfPreviewUrl}
                        title={contractDetail.title || "Contract preview"}
                      />
                    </Suspense>
                  ) : (
                    <div
                      className="h-full flex items-center justify-center px-4"
                      data-testid="status-contract-pdf-unavailable"
                    >
                      <div
                        className="bg-red-50 border border-red-200 text-red-700 rounded-md px-3 py-2 text-xs max-w-md w-full flex flex-col items-start gap-2"
                        data-testid="banner-contract-pdf-preview-error"
                      >
                        <p className="text-left">
                          {contractPdfPreviewDisconnected
                            ? "PandaDoc is not connected. Reconnect it from the Integrations page to preview this contract."
                            : contractPdfPreviewNotReady
                              ? "This contract isn't ready in PandaDoc yet. Try again in a moment."
                              : contractPdfPreviewError || "Preview is unavailable. Use \"Open in PandaDoc\" or \"Download PDF\" above to view the contract."}
                        </p>
                        {contractPdfPreviewNotReady && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs border-red-300 text-red-700 hover:bg-red-100"
                            onClick={() => contractPdfPreviewLoadRef.current?.()}
                            data-testid="button-contract-pdf-preview-retry"
                          >
                            <RotateCw className="w-3.5 h-3.5 mr-1.5" />
                            Retry
                          </Button>
                        )}
                        {contractPdfPreviewDisconnected && (
                          <a
                            href="/admin/integrations"
                            className="inline-flex items-center gap-1 text-xs font-medium text-red-700 underline hover:text-red-800"
                            data-testid="link-contract-pdf-preview-integrations"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            Open Integrations
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-3 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">Status</span>
                  <p className="capitalize font-medium" data-testid="text-detail-status">{contractDetail.status.replace("document.", "").replace(/_/g, " ")}</p>
                </div>
                {contractDetail.createdDate && (
                  <div>
                    <span className="text-xs text-muted-foreground">Created</span>
                    <p className="font-medium">{format(new Date(contractDetail.createdDate), "MMM d, yyyy")}</p>
                  </div>
                )}
                {contractDetail.completedDate && (
                  <div>
                    <span className="text-xs text-muted-foreground">Completed</span>
                    <p className="font-medium">{format(new Date(contractDetail.completedDate), "MMM d, yyyy")}</p>
                  </div>
                )}
                {contractDetail.lastSyncedAt && (
                  <div>
                    <span className="text-xs text-muted-foreground">Last Synced</span>
                    <p className="font-medium">{format(new Date(contractDetail.lastSyncedAt), "MMM d, yyyy h:mm a")}</p>
                  </div>
                )}
              </div>
              {contractDetail.recipientsJson && Array.isArray(contractDetail.recipientsJson) && contractDetail.recipientsJson.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Recipients</p>
                  <div className="flex flex-wrap gap-1">
                    {contractDetail.recipientsJson.map((r: any, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">
                        {r.first_name || r.last_name ? `${r.first_name || ""} ${r.last_name || ""}`.trim() : r.email || "Unknown"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground mb-2">Document Content</p>
                {contractDetail.contentText ? (
                  <div className="bg-surface-warm-1 rounded-lg p-4 text-sm whitespace-pre-wrap max-h-[400px] overflow-y-auto" data-testid="text-contract-content">
                    {contractDetail.contentText}
                  </div>
                ) : (
                  <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground text-center" data-testid="text-no-content">
                    Extracted text isn't available for this document. Use "Open in PandaDoc" or "Download PDF" above to view the contract.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ChangelogViewer
        clientId={clientId}
        open={historyOpen}
        onOpenChange={(o) => {
          setHistoryOpen(o);
          if (!o) setHistorySectionFields(null);
        }}
        allUsers={allUsers}
        lastReviewedAt={panel?.lastReviewedAt ?? null}
        sectionFieldFilters={historySectionFields}
      />
    </div>
  );
}

export { ReviewBadge };
