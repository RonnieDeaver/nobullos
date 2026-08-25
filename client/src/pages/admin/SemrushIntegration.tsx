import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  RefreshCw,
  Link2,
  ListChecks,
  MapPin,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/admin/PageHeader";
import { SectionNav, type SectionNavItem } from "@/components/admin/SectionNav";
import { useAuth } from "@/hooks/use-auth";
import { SemrushBackfillPanel } from "@/components/admin/SemrushBackfillPanel";
import { HeatmapCoveragePanel } from "@/components/admin/HeatmapCoveragePanel";
import {
  SemrushOverviewPanel,
  SemrushSyncStatePanel,
  SemrushRecentJobsPanel,
} from "@/components/admin/SemrushConsolePanels";

/**
 * Task #4355 — SectionNav registry for the SEMrush console monolith (audit
 * §6.1-E): seven stacked operations panels, one sticky rail.
 */
const SEMRUSH_CONSOLE_SECTIONS: SectionNavItem[] = [
  { id: "overview", label: "Overview" },
  { id: "sync-state", label: "Sync state" },
  { id: "mapping-inventory", label: "Mapping inventory" },
  { id: "mapping-suggestions", label: "Mapping suggestions" },
  { id: "heatmap-coverage", label: "Heatmap coverage" },
  { id: "backfill", label: "Historical backfill" },
  { id: "recent-jobs", label: "Recent jobs" },
];

type PanelPlaceholderProps = {
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
  title: string;
  subtitle: string;
  comingIn: string;
};

function PanelPlaceholder({
  testId,
  icon: Icon,
  iconClassName,
  title,
  subtitle,
  comingIn,
}: PanelPlaceholderProps) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
          <Icon className={`w-5 h-5 ${iconClassName}`} />
          {title}
        </CardTitle>
        <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
      </CardHeader>
      <CardContent>
        <p
          className="text-sm text-gray-500 italic"
          data-testid={`${testId}-empty`}
        >
          {comingIn}
        </p>
      </CardContent>
    </Card>
  );
}

type InventoryItem = {
  id: string;
  clientId: string;
  firmName: string | null;
  locationId: string;
  locationLabel: string | null;
  locationAddress: string | null;
  locationConfigured: boolean;
  semrushCampaignId: string;
  semrushCampaignName: string | null;
  isStale: boolean;
  staleSince: string | null;
  createdAt: string | null;
  status: "linked" | "stale" | "orphan_location";
};

type InventoryResponse = {
  items: InventoryItem[];
  totalCount: number;
  shownCount: number;
  counts: { linked: number; stale: number; orphanLocation: number };
};

type SuggestionItem = {
  id: string;
  clientId: string;
  firmName: string | null;
  surface: string;
  reason: string | null;
  createdAt: string | null;
  candidate: {
    locationId: string | null;
    semrushCampaignId: string | null;
    semrushCampaignName: string | null;
  };
  locationLabel: string | null;
  classification:
    | "promotable"
    | "blocked_unconfigured"
    | "already_mapped"
    | "stale_conflict"
    | "invalid";
  canApprove: boolean;
  canReject: boolean;
  note: string | null;
};

type SuggestionsResponse = {
  items: SuggestionItem[];
  totalCount: number;
  shownCount: number;
  counts: {
    promotable: number;
    blockedUnconfigured: number;
    alreadyMapped: number;
    staleConflict: number;
    invalid: number;
  };
};

const INVENTORY_STATUS_LABEL: Record<InventoryItem["status"], string> = {
  linked: "Linked",
  stale: "Stale",
  orphan_location: "Orphan location",
};

const INVENTORY_STATUS_CLASS: Record<InventoryItem["status"], string> = {
  linked: "bg-emerald-50 text-emerald-700 border-emerald-200",
  stale: "bg-amber-50 text-amber-700 border-amber-200",
  orphan_location: "bg-rose-50 text-rose-700 border-rose-200",
};

const SUGGESTION_LABEL: Record<SuggestionItem["classification"], string> = {
  promotable: "Promotable",
  blocked_unconfigured: "Blocked — location not configured",
  already_mapped: "Already mapped",
  stale_conflict: "Stale conflict",
  invalid: "Invalid",
};

const SUGGESTION_CLASS: Record<SuggestionItem["classification"], string> = {
  promotable: "bg-emerald-50 text-emerald-700 border-emerald-200",
  blocked_unconfigured: "bg-rose-50 text-rose-700 border-rose-200",
  already_mapped: "bg-blue-50 text-blue-700 border-blue-200",
  stale_conflict: "bg-amber-50 text-amber-700 border-amber-200",
  invalid: "bg-gray-100 text-gray-700 border-gray-200",
};

function MappingInventoryPanel() {
  const [search, setSearch] = useState("");
  const { data, isLoading, isFetching, refetch, error } = useQuery<InventoryResponse>({
    queryKey: ["/api/integrations/semrush/mapping-inventory"],
  });

  const filtered = (() => {
    if (!data) return [];
    if (!search.trim()) return data.items;
    const s = search.trim().toLowerCase();
    return data.items.filter((i) =>
      [
        i.firmName,
        i.locationLabel,
        i.locationAddress,
        i.semrushCampaignName,
        i.semrushCampaignId,
        i.clientId,
        i.locationId,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s)),
    );
  })();

  return (
    <Card data-testid="section-semrush-mapping-inventory">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
              <Link2 className="w-5 h-5 text-purple-600" />
              Mapping Inventory
            </CardTitle>
            <p className="text-xs text-gray-500 mt-1">
              Current <code>semrush_location_campaigns</code> rows joined to
              their client and location.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-mapping-inventory"
          >
            {isFetching ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
        {data && (
          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Badge variant="outline" className={INVENTORY_STATUS_CLASS.linked} data-testid="badge-inventory-count-linked">
              Linked: {data.counts.linked}
            </Badge>
            <Badge variant="outline" className={INVENTORY_STATUS_CLASS.stale} data-testid="badge-inventory-count-stale">
              Stale: {data.counts.stale}
            </Badge>
            <Badge variant="outline" className={INVENTORY_STATUS_CLASS.orphan_location} data-testid="badge-inventory-count-orphan">
              Orphan: {data.counts.orphanLocation}
            </Badge>
            <span className="text-xs text-gray-500" data-testid="text-inventory-total">
              Total: {data.totalCount}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by client, location, or campaign..."
          aria-label="Filter mapping inventory by client, location, or campaign"
          data-testid="input-mapping-inventory-search"
        />
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500" data-testid="text-mapping-inventory-loading">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div className="text-sm text-rose-600" data-testid="text-mapping-inventory-error">
            Failed to load mapping inventory.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-gray-500 italic" data-testid="text-mapping-inventory-empty">
            No mapping rows match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm" data-testid="table-mapping-inventory">
              <thead className="bg-slate-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-left px-3 py-2">Location</th>
                  <th className="text-left px-3 py-2">Campaign</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t"
                    data-testid={`row-mapping-inventory-${row.id}`}
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{row.firmName || "—"}</div>
                      <code className="text-xs text-gray-500 font-mono" title={row.clientId}>
                        {row.clientId.slice(0, 8)}…
                      </code>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div>{row.locationLabel || (row.locationConfigured ? row.locationId : "(not configured)")}</div>
                      {row.locationAddress && (
                        <div className="text-xs text-gray-500">{row.locationAddress}</div>
                      )}
                      <div className="text-xs text-gray-500 font-mono">{row.locationId}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div>{row.semrushCampaignName || "—"}</div>
                      <div className="text-xs text-gray-500 font-mono">{row.semrushCampaignId}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge
                        variant="outline"
                        className={INVENTORY_STATUS_CLASS[row.status]}
                        data-testid={`badge-inventory-status-${row.id}`}
                      >
                        {INVENTORY_STATUS_LABEL[row.status]}
                      </Badge>
                      {row.status === "stale" && row.staleSince && (
                        <div className="text-xs text-gray-500 mt-1">
                          since {new Date(row.staleSince).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MappingSuggestionsPanel() {
  const [search, setSearch] = useState("");
  const [actionResult, setActionResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isFetching, refetch, error } = useQuery<SuggestionsResponse>({
    queryKey: ["/api/integrations/semrush/mapping-suggestions"],
  });

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/semrush/mapping-suggestions"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/semrush/mapping-inventory"] }); // fire-and-forget: cache refresh only
  };

  const approveMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/integrations/semrush/mapping-suggestions/${id}/approve`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || json?.error || `Approve failed (${res.status})`);
      return { id, ...json };
    },
    onSuccess: (data) => {
      setActionResult((prev) => ({
        ...prev,
        [data.id]: { ok: true, message: data.message || "Approved." },
      }));
      toast({ title: "Suggestion approved", description: data.message });
      invalidateAll();
    },
    onError: (err: any, id) => {
      setActionResult((prev) => ({
        ...prev,
        [id]: { ok: false, message: err?.message || "Approve failed" },
      }));
      toast({
        title: "Approve failed",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
      invalidateAll();
    },
  });

  const rejectMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/integrations/semrush/mapping-suggestions/${id}/reject`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || json?.error || `Reject failed (${res.status})`);
      return { id, ...json };
    },
    onSuccess: (data) => {
      setActionResult((prev) => ({
        ...prev,
        [data.id]: { ok: true, message: data.message || "Dismissed." },
      }));
      toast({ title: "Suggestion dismissed" });
      invalidateAll();
    },
    onError: (err: any, id) => {
      setActionResult((prev) => ({
        ...prev,
        [id]: { ok: false, message: err?.message || "Reject failed" },
      }));
      toast({
        title: "Reject failed",
        description: err?.message || "Try again.",
        variant: "destructive",
      });
    },
  });

  const filtered = (() => {
    if (!data) return [];
    if (!search.trim()) return data.items;
    const s = search.trim().toLowerCase();
    return data.items.filter((i) =>
      [
        i.firmName,
        i.locationLabel,
        i.candidate.semrushCampaignName,
        i.candidate.semrushCampaignId,
        i.clientId,
        i.candidate.locationId,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(s)),
    );
  })();

  return (
    <Card data-testid="section-semrush-mapping-suggestions">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
              <ListChecks className="w-5 h-5 text-purple-600" />
              Suggestions Queue
            </CardTitle>
            <p className="text-xs text-gray-500 mt-1">
              Pending <code>import_entity_suggestions</code> rows for SEMrush
              location ↔ campaign mappings. Approve goes through the canonical
              writer; reject dismisses the suggestion.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-mapping-suggestions"
          >
            {isFetching ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            )}
            Refresh
          </Button>
        </div>
        {data && (
          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Badge variant="outline" className={SUGGESTION_CLASS.promotable} data-testid="badge-suggestions-count-promotable">
              Promotable: {data.counts.promotable}
            </Badge>
            <Badge variant="outline" className={SUGGESTION_CLASS.blocked_unconfigured} data-testid="badge-suggestions-count-blocked">
              Blocked: {data.counts.blockedUnconfigured}
            </Badge>
            <Badge variant="outline" className={SUGGESTION_CLASS.already_mapped} data-testid="badge-suggestions-count-already-mapped">
              Already mapped: {data.counts.alreadyMapped}
            </Badge>
            <Badge variant="outline" className={SUGGESTION_CLASS.stale_conflict} data-testid="badge-suggestions-count-stale">
              Stale: {data.counts.staleConflict}
            </Badge>
            {data.counts.invalid > 0 && (
              <Badge variant="outline" className={SUGGESTION_CLASS.invalid} data-testid="badge-suggestions-count-invalid">
                Invalid: {data.counts.invalid}
              </Badge>
            )}
            <span className="text-xs text-gray-500" data-testid="text-suggestions-total">
              Total pending: {data.totalCount}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by client, location, or campaign..."
          aria-label="Filter mapping suggestions by client, location, or campaign"
          data-testid="input-mapping-suggestions-search"
        />
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500" data-testid="text-mapping-suggestions-loading">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading...
          </div>
        ) : error ? (
          <div className="text-sm text-rose-600" data-testid="text-mapping-suggestions-error">
            Failed to load suggestions.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-sm text-gray-500 italic" data-testid="text-mapping-suggestions-empty">
            No pending suggestions match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm" data-testid="table-mapping-suggestions">
              <thead className="bg-slate-50 text-xs uppercase text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2">Client</th>
                  <th className="text-left px-3 py-2">Location</th>
                  <th className="text-left px-3 py-2">Campaign</th>
                  <th className="text-left px-3 py-2">State</th>
                  <th className="text-left px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const result = actionResult[s.id];
                  const pending =
                    (approveMutation.isPending && approveMutation.variables === s.id) ||
                    (rejectMutation.isPending && rejectMutation.variables === s.id);
                  return (
                    <tr
                      key={s.id}
                      className="border-t align-top"
                      data-testid={`row-mapping-suggestion-${s.id}`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{s.firmName || "—"}</div>
                        <code className="text-xs text-gray-500 font-mono" title={s.clientId}>
                          {s.clientId.slice(0, 8)}…
                        </code>
                      </td>
                      <td className="px-3 py-2">
                        <div>{s.locationLabel || "(not configured)"}</div>
                        <div className="text-xs text-gray-500 font-mono">
                          {s.candidate.locationId || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{s.candidate.semrushCampaignName || "—"}</div>
                        <div className="text-xs text-gray-500 font-mono">
                          {s.candidate.semrushCampaignId || "—"}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge
                          variant="outline"
                          className={SUGGESTION_CLASS[s.classification]}
                          data-testid={`badge-suggestion-state-${s.id}`}
                        >
                          {SUGGESTION_LABEL[s.classification]}
                        </Badge>
                        {s.note && (
                          <div className="text-xs text-gray-500 mt-1">{s.note}</div>
                        )}
                        <div className="text-xs text-gray-400 mt-1">
                          surface: {s.surface}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1.5">
                          <div className="flex gap-1.5 flex-wrap">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!s.canApprove || pending}
                              onClick={() => approveMutation.mutate(s.id)}
                              data-testid={`button-approve-suggestion-${s.id}`}
                            >
                              {pending && approveMutation.variables === s.id ? (
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-3 h-3 mr-1 text-emerald-600" />
                              )}
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!s.canReject || pending}
                              onClick={() => rejectMutation.mutate(s.id)}
                              data-testid={`button-reject-suggestion-${s.id}`}
                            >
                              {pending && rejectMutation.variables === s.id ? (
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              ) : (
                                <XCircle className="w-3 h-3 mr-1 text-rose-600" />
                              )}
                              Reject
                            </Button>
                          </div>
                          {result && (
                            <div
                              className={`text-xs ${result.ok ? "text-emerald-700" : "text-rose-600"}`}
                              data-testid={`text-suggestion-result-${s.id}`}
                            >
                              {result.message}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SemrushIntegration() {
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  const canAccessConsole = isAdmin || user?.role === "account_manager";

  const handleRefresh = () => {
    // Invalidate every SEMrush-scoped query the console (and any mounted
    // panels) read from. React Query's queryKey matching is exact at each
    // tuple slot, so we use a predicate that matches any single-string key
    // beginning with "/api/semrush" or "/api/integrations/semrush" — this
    // covers the Historical Backfill panel's `/api/semrush/status` and
    // `/api/semrush/inventory/status` queries, the 936C console panels
    // (`/api/semrush/console/...`), and the 936D mapping
    // inventory/suggestions endpoints (`/api/integrations/semrush/...`).
    void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
      predicate: (q) => {
        const k = q.queryKey?.[0];
        return (
          typeof k === "string" &&
          (k.startsWith("/api/semrush") ||
            k.startsWith("/api/integrations/semrush"))
        );
      },
    });
  };

  if (authLoading) {
    return (
      <div
        className="container mx-auto p-4 sm:p-6 max-w-6xl"
        data-testid="page-semrush-console-loading"
      >
        <p className="text-sm text-gray-500">Loading…</p>
      </div>
    );
  }

  if (!user || !canAccessConsole) {
    return (
      <div
        className="container mx-auto p-4 sm:p-6 max-w-6xl"
        data-testid="page-semrush-console-denied"
      >
        <Card>
          <CardHeader>
            <CardTitle>Access denied</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-600">
              The SEMrush Operations Console is restricted to Account Manager access or higher.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="container mx-auto p-4 sm:p-6 max-w-6xl space-y-4"
      data-testid="page-semrush-console"
    >
      {/* Task #4355 — Pattern-B → shared PageHeader (audit §6.1-B / P1-4). */}
      <PageHeader
        title="SEMrush Operations Console"
        icon={MapPin}
        backHref="/admin/integrations"
        backLabel="Integrations"
        subtitle="One home for the SEMrush sync layer: pipeline health, sync state, mapping inventory, historical backfill, and recent jobs."
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            data-testid="button-refresh-semrush-console"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            Refresh
          </Button>
        }
      />
      <div
        className="text-xs text-gray-500 text-right"
        data-testid="text-console-canonical-note"
      >
        Canonical SEMrush operations console
      </div>

      {/* Task #4355 — SectionNav wayfinding shell for the console monolith
          (audit §6.1-E). Panel content untouched. */}
      <div className="flex items-start gap-6">
        <div className="flex-1 min-w-0 space-y-4">
          <section id="overview" className="scroll-mt-16">
            <SemrushOverviewPanel />
          </section>
          <section id="sync-state" className="scroll-mt-16">
            <SemrushSyncStatePanel />
          </section>
          <section id="mapping-inventory" className="scroll-mt-16">
            <MappingInventoryPanel />
          </section>
          <section id="mapping-suggestions" className="scroll-mt-16">
            <MappingSuggestionsPanel />
          </section>
          <section id="heatmap-coverage" className="scroll-mt-16">
            <HeatmapCoveragePanel />
          </section>
          <section id="backfill" className="scroll-mt-16">
            <SemrushBackfillPanel />
          </section>
          <section id="recent-jobs" className="scroll-mt-16">
            <SemrushRecentJobsPanel />
          </section>
        </div>
        <SectionNav
          sections={SEMRUSH_CONSOLE_SECTIONS}
          className="hidden xl:block w-56 shrink-0"
        />
      </div>
    </div>
  );
}
