import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  History, Filter, Calendar, User, ArrowRight, Plus, Minus,
  ChevronDown, ChevronUp, AlertCircle
} from "lucide-react";
import { format, formatDistanceToNow, startOfDay, endOfDay } from "date-fns";

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

type UserInfo = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

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
  externalSystemLinks: "External System Links",
};

const LONG_TEXT_FIELDS = new Set([
  "onboardingNotes", "annualGoals", "longTermGoals", "quarterPrimaryObjective",
  "successDefinitionQuarter", "growthStrategy", "geographicExpansionNotes",
  "googleAdsGeoNotes", "webinarGeoNotes", "activeCampaignFocus", "activeOffers",
  "keyActiveInitiatives", "currentRiskFlags", "currentOpportunities",
  "clientPreferences", "internalHandlingNotes", "productStatusNotes",
  "approvedTerritory", "googleAdsExcludedAreas",
]);

function computeInlineDiff(oldText: string, newText: string): { type: "same" | "add" | "remove"; text: string }[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);

  const m = oldWords.length;
  const n = newWords.length;

  if (m * n > 100000) {
    const result: { type: "same" | "add" | "remove"; text: string }[] = [];
    if (oldText) result.push({ type: "remove", text: oldText });
    if (newText) result.push({ type: "add", text: newText });
    return result;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: { type: "same" | "add" | "remove"; text: string }[] = [];
  let i = m, j = n;
  const raw: { type: "same" | "add" | "remove"; text: string }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      raw.push({ type: "same", text: oldWords[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ type: "add", text: newWords[j - 1] });
      j--;
    } else {
      raw.push({ type: "remove", text: oldWords[i - 1] });
      i--;
    }
  }

  raw.reverse();

  let current: { type: "same" | "add" | "remove"; text: string } | null = null;
  for (const segment of raw) {
    if (current && current.type === segment.type) {
      current.text += segment.text;
    } else {
      if (current) result.push(current);
      current = { ...segment };
    }
  }
  if (current) result.push(current);

  return result;
}

function InlineDiff({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  const segments = useMemo(() => computeInlineDiff(oldValue, newValue), [oldValue, newValue]);

  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap font-mono bg-gray-50 p-3 rounded border" data-testid="inline-diff">
      {segments.map((seg, i) => {
        if (seg.type === "remove") {
          return (
            <span key={i} className="bg-red-100 text-red-800 line-through decoration-red-400">
              {seg.text}
            </span>
          );
        }
        if (seg.type === "add") {
          return (
            <span key={i} className="bg-green-100 text-green-800">
              {seg.text}
            </span>
          );
        }
        return <span key={i}>{seg.text}</span>;
      })}
    </div>
  );
}

function SideBySideDiff({ oldValue, newValue }: { oldValue: string | null; newValue: string | null }) {
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="side-by-side-diff">
      <div>
        <p className="text-xs text-gray-500 mb-1 font-medium">Previous</p>
        <p className="text-sm bg-red-50 text-red-800 p-2 rounded border border-red-100 break-all min-h-[32px]">
          {oldValue || <span className="text-gray-400 italic">empty</span>}
        </p>
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-1 font-medium">New</p>
        <p className="text-sm bg-green-50 text-green-800 p-2 rounded border border-green-100 break-all min-h-[32px]">
          {newValue || <span className="text-gray-400 italic">empty</span>}
        </p>
      </div>
    </div>
  );
}

function ValueDiff({ fieldName, oldValue, newValue }: { fieldName: string; oldValue: string | null; newValue: string | null }) {
  const isLongText = LONG_TEXT_FIELDS.has(fieldName);
  const hasSubstantialContent = (oldValue?.length || 0) > 40 || (newValue?.length || 0) > 40;

  if (isLongText && hasSubstantialContent && oldValue && newValue) {
    return <InlineDiff oldValue={oldValue} newValue={newValue} />;
  }

  return <SideBySideDiff oldValue={oldValue} newValue={newValue} />;
}

type DateGroupedHistory = {
  date: string;
  entries: HistoryEntry[];
};

function groupByDate(entries: HistoryEntry[]): DateGroupedHistory[] {
  const groups: Record<string, HistoryEntry[]> = {};
  for (const entry of entries) {
    const dateKey = format(new Date(entry.createdAt), "yyyy-MM-dd");
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(entry);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, entries]) => ({ date, entries }));
}

interface ChangelogViewerProps {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allUsers: UserInfo[];
  lastReviewedAt: string | null;
  /**
   * Optional list of `command_panel_history.field_name` values to scope
   * the viewer to. Used by the per-section "Last edited by …" badges
   * (Task #999) so a click on the Strategy badge opens history filtered
   * to strategy fields only. The dropdown filter still works on top of
   * this scope.
   */
  sectionFieldFilters?: string[] | null;
}

export default function ChangelogViewer({ clientId, open, onOpenChange, allUsers, lastReviewedAt, sectionFieldFilters }: ChangelogViewerProps) {
  const [filterField, setFilterField] = useState<string>("all");
  const [filterUser, setFilterUser] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [sinceLastReview, setSinceLastReview] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (sinceLastReview && lastReviewedAt) {
      params.set("sinceLastReview", "true");
    } else {
      if (filterField !== "all") params.set("fieldName", filterField);
      if (filterUser !== "all") params.set("changedBy", filterUser);
      if (filterDateFrom) params.set("dateFrom", new Date(filterDateFrom).toISOString());
      if (filterDateTo) params.set("dateTo", endOfDay(new Date(filterDateTo)).toISOString());
    }
    return params.toString();
  }, [filterField, filterUser, filterDateFrom, filterDateTo, sinceLastReview, lastReviewedAt]);

  const { data: allHistory, isLoading: allHistoryLoading } = useQuery<HistoryEntry[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "history", "all"],
    queryFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/history`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json();
    },
    enabled: open,
  });

  const hasActiveFilters = filterField !== "all" || filterUser !== "all" || !!filterDateFrom || !!filterDateTo || sinceLastReview;

  const { data: history, isLoading } = useQuery<HistoryEntry[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "history", queryParams],
    queryFn: async () => {
      const url = `/api/clients/${clientId}/command-panel/history${queryParams ? `?${queryParams}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch history");
      return res.json();
    },
    enabled: open && hasActiveFilters,
  });

  const rawDisplayHistory = hasActiveFilters ? history : allHistory;
  const displayHistory = useMemo(() => {
    if (!sectionFieldFilters || sectionFieldFilters.length === 0) return rawDisplayHistory;
    const allowed = new Set(sectionFieldFilters);
    return (rawDisplayHistory || []).filter((e) => allowed.has(e.fieldName));
  }, [rawDisplayHistory, sectionFieldFilters]);

  const grouped = useMemo(() => groupByDate(displayHistory || []), [displayHistory]);

  const sinceLastReviewCount = useMemo(() => {
    if (!lastReviewedAt || !allHistory) return 0;
    return allHistory.filter(e => new Date(e.createdAt) > new Date(lastReviewedAt)).length;
  }, [allHistory, lastReviewedAt]);

  const getUserName = (userId: string) => {
    const u = allUsers.find(u => u.id === userId) ?? null;
    return formatEditorAttribution(
      { changedBy: userId, changedByUser: u },
      "Unknown",
    );
  };

  const uniqueFields = useMemo(() => {
    if (!allHistory) return [];
    const fields = new Set(allHistory.map(h => h.fieldName));
    return Array.from(fields).sort();
  }, [allHistory]);

  const uniqueUsers = useMemo(() => {
    if (!allHistory) return [];
    const userIds = new Set(allHistory.map(h => h.changedBy));
    return Array.from(userIds);
  }, [allHistory]);

  const clearFilters = () => {
    setFilterField("all");
    setFilterUser("all");
    setFilterDateFrom("");
    setFilterDateTo("");
    setSinceLastReview(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-[640px] overflow-y-auto p-0" data-testid="changelog-viewer">
        <SheetHeader className="p-6 pb-0">
          <SheetTitle className="text-foreground flex items-center gap-2">
            <History className="w-5 h-5" />
            Change History
          </SheetTitle>
        </SheetHeader>

        <div className="p-6 pt-4 space-y-4">
          {lastReviewedAt && !sinceLastReview && sinceLastReviewCount > 0 && (
            <div
              className="bg-amber-50 border border-amber-200 rounded-lg p-3 cursor-pointer hover:bg-amber-100 transition-colors"
              onClick={() => { setSinceLastReview(true); setFiltersExpanded(false); }}
              data-testid="banner-changes-since-review"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600" />
                  <span className="text-sm font-medium text-amber-800">
                    {sinceLastReviewCount} change{sinceLastReviewCount !== 1 ? "s" : ""} since last review
                  </span>
                </div>
                <span className="text-xs text-amber-600">
                  Last reviewed {format(new Date(lastReviewedAt), "MMM d, yyyy")}
                </span>
              </div>
              <p className="text-xs text-amber-600 mt-1">Click to view only changes since last review</p>
            </div>
          )}

          {sinceLastReview && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3" data-testid="banner-since-review-active">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-medium text-blue-800">
                    Showing changes since last review ({lastReviewedAt ? format(new Date(lastReviewedAt), "MMM d, yyyy") : ""})
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-600 hover:text-blue-800 h-7 px-2"
                  onClick={clearFilters}
                  data-testid="button-show-all-history"
                >
                  Show all
                </Button>
              </div>
            </div>
          )}

          <div className="border rounded-lg">
            <button
              className="w-full flex items-center justify-between p-3 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              onClick={() => setFiltersExpanded(!filtersExpanded)}
              data-testid="button-toggle-filters"
            >
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4" />
                <span>Filters</span>
                {hasActiveFilters && (
                  <Badge variant="secondary" className="text-xs">Active</Badge>
                )}
              </div>
              {filtersExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {filtersExpanded && (
              <div className="p-3 pt-0 space-y-3 border-t" data-testid="filters-panel">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Field</label>
                    <Select value={filterField} onValueChange={(v) => { setFilterField(v); setSinceLastReview(false); }}>
                      <SelectTrigger className="h-8 text-xs" data-testid="select-filter-field">
                        <SelectValue placeholder="All fields" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All fields</SelectItem>
                        {uniqueFields.map(f => (
                          <SelectItem key={f} value={f}>{FIELD_LABELS[f] || f}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Changed by</label>
                    <Select value={filterUser} onValueChange={(v) => { setFilterUser(v); setSinceLastReview(false); }}>
                      <SelectTrigger className="h-8 text-xs" data-testid="select-filter-user">
                        <SelectValue placeholder="Anyone" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Anyone</SelectItem>
                        {uniqueUsers.map(uid => (
                          <SelectItem key={uid} value={uid}>{getUserName(uid)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">From date</label>
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      value={filterDateFrom}
                      onChange={(e) => { setFilterDateFrom(e.target.value); setSinceLastReview(false); }}
                      data-testid="input-filter-date-from"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">To date</label>
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      value={filterDateTo}
                      onChange={(e) => { setFilterDateTo(e.target.value); setSinceLastReview(false); }}
                      data-testid="input-filter-date-to"
                    />
                  </div>
                </div>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={clearFilters}
                    data-testid="button-clear-filters"
                  >
                    Clear all filters
                  </Button>
                )}
              </div>
            )}
          </div>

          {(isLoading || allHistoryLoading) ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
            </div>
          ) : !displayHistory || displayHistory.length === 0 ? (
            <div className="text-center py-12" data-testid="text-no-history">
              <History className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No changes recorded{hasActiveFilters ? " matching your filters" : " yet"}.</p>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-6" data-testid="changelog-timeline">
              {grouped.map((group) => (
                <div key={group.date}>
                  <div className="flex items-center gap-2 mb-3 sticky top-0 bg-card/95 backdrop-blur py-1 z-10">
                    <Calendar className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                      {format(new Date(group.date), "EEEE, MMMM d, yyyy")}
                    </span>
                    <Badge variant="secondary" className="text-xs ml-auto">
                      {group.entries.length} change{group.entries.length !== 1 ? "s" : ""}
                    </Badge>
                  </div>

                  <div className="space-y-2 pl-2 border-l-2 border-gray-200 ml-1.5">
                    {group.entries.map((entry) => (
                      <div
                        key={entry.id}
                        className="relative pl-4 pb-3"
                        data-testid={`changelog-entry-${entry.id}`}
                      >
                        <div className="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-primary" />

                        <div className="bg-[#FAFAF8] rounded-lg p-3 border border-gray-100 hover:border-gray-200 transition-colors">
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className="text-xs bg-primary/10 text-primary border-primary/20 hover:bg-primary/15">
                                {FIELD_LABELS[entry.fieldName] || entry.fieldName}
                              </Badge>
                              <div className="flex items-center gap-1 text-xs text-gray-500">
                                <User className="w-3 h-3" />
                                {getUserName(entry.changedBy)}
                              </div>
                            </div>
                            <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                              {format(new Date(entry.createdAt), "h:mm a")}
                            </span>
                          </div>

                          <ValueDiff
                            fieldName={entry.fieldName}
                            oldValue={entry.oldValue}
                            newValue={entry.newValue}
                          />

                          {entry.reason && (
                            <div className="mt-2 flex items-start gap-1.5">
                              <ArrowRight className="w-3 h-3 text-gray-400 mt-0.5 shrink-0" />
                              <p className="text-xs text-gray-600 italic">{entry.reason}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {displayHistory && displayHistory.length > 0 && (
            <p className="text-xs text-gray-400 text-center pt-2">
              Showing {displayHistory.length} change{displayHistory.length !== 1 ? "s" : ""}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
