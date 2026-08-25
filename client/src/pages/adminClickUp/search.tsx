// ClickUp admin — workspace search / saved filter presets panel.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BookmarkPlus,
  CheckCircle,
  ExternalLink,
  Filter,
  Loader2,
  Plus,
  Search,
  Tag,
  X,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { Space, Task } from "./types";
import { fmtDate, priorityLabel, statusColor } from "./lib";
import { TaskDetailDialog } from "./taskDetail";

// ─── Search / My Work panel ───────────────────────────────────────────────────

export type FacetStatus = { status: string; color?: string; type?: string };
export type FacetMember = { id: string; username: string; email?: string };
export type FacetTag = { name: string; color?: string };
export type Facets = { statuses: FacetStatus[]; members: FacetMember[]; tags: FacetTag[] };

export type CustomFieldFilter = {
  field_id: string;
  operator: string;
  value?: string;
  rangeFrom?: string;
  rangeTo?: string;
};

export type FilterPreset = {
  id: string;
  name: string;
  workspaceId: string;
  filters: SearchFilters;
  createdAt: string;
};

export type SearchFilters = {
  query: string;
  statuses: string[];
  assignees: string[];
  tags: string[];
  priorities: number[];
  dueDateGt: string;
  dueDateLt: string;
  startDateGt: string;
  startDateLt: string;
  includeClosed: boolean;
  spaceIds: string[];
  listIds: string[];
  customFields: CustomFieldFilter[];
};

export const EMPTY_FILTERS: SearchFilters = {
  query: "",
  statuses: [],
  assignees: [],
  tags: [],
  priorities: [],
  dueDateGt: "",
  dueDateLt: "",
  startDateGt: "",
  startDateLt: "",
  includeClosed: false,
  spaceIds: [],
  listIds: [],
  customFields: [],
};

export const PRIORITY_OPTIONS = [
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Normal" },
  { value: 4, label: "Low" },
];

export const CF_OPERATORS = [
  "=", "!=", "contains", "not contains", "starts with", "ends with",
  "<", ">", "<=", ">=", "is null", "is not null", "RANGE",
];

export function buildSearchUrl(workspaceId: string, filters: SearchFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  params.set("page", String(page));
  if (filters.includeClosed) params.set("include_closed", "true");
  if (filters.statuses.length) params.set("statuses", filters.statuses.join(","));
  if (filters.assignees.length) params.set("assignees", filters.assignees.join(","));
  if (filters.tags.length) params.set("tags", filters.tags.join(","));
  if (filters.priorities.length) params.set("priorities", filters.priorities.join(","));
  if (filters.spaceIds.length) params.set("space_ids", filters.spaceIds.join(","));
  if (filters.listIds.length) params.set("list_ids", filters.listIds.join(","));
  if (filters.dueDateGt) params.set("due_date_gt", String(new Date(filters.dueDateGt).getTime()));
  if (filters.dueDateLt) params.set("due_date_lt", String(new Date(filters.dueDateLt).getTime()));
  if (filters.startDateGt) params.set("start_date_gt", String(new Date(filters.startDateGt).getTime()));
  if (filters.startDateLt) params.set("start_date_lt", String(new Date(filters.startDateLt).getTime()));
  if (filters.customFields.length) {
    const cff = filters.customFields
      .filter((f) => f.field_id && f.operator)
      .map((f) =>
        f.operator === "RANGE"
          ? { field_id: f.field_id, operator: "RANGE", value: { lower: f.rangeFrom ?? "", upper: f.rangeTo ?? "" } }
          : { field_id: f.field_id, operator: f.operator, value: f.value },
      );
    if (cff.length) params.set("custom_fields", JSON.stringify(cff));
  }
  return `/api/clickup/workspaces/${workspaceId}/search?${params}`;
}

export function activeFilterCount(f: SearchFilters): number {
  return (
    (f.query ? 1 : 0) +
    f.statuses.length +
    f.assignees.length +
    f.tags.length +
    f.priorities.length +
    f.spaceIds.length +
    f.listIds.length +
    (f.dueDateGt || f.dueDateLt ? 1 : 0) +
    (f.startDateGt || f.startDateLt ? 1 : 0) +
    f.customFields.filter((c) => c.field_id && c.operator).length
  );
}

export function MultiToggle<T extends string | number>({
  options,
  selected,
  onChange,
  label,
  testId,
}: {
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onChange(v: T[]): void;
  label: string;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex flex-wrap gap-1" data-testid={testId}>
        {options.map((o) => {
          const active = selected.includes(o.value);
          return (
            <button
              key={String(o.value)}
              onClick={() =>
                onChange(active ? selected.filter((s) => s !== o.value) : [...selected, o.value])
              }
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${active ? "bg-purple-600 border-purple-600 text-white" : "bg-card border-border text-muted-foreground hover:border-purple-300"}`}
              data-testid={`toggle-${testId}-${o.value}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SearchPanel({
  workspaceId,
  spaces,
}: {
  workspaceId: string;
  spaces: Space[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_FILTERS);
  const [committed, setCommitted] = useState<SearchFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Facets from mirror (instant, no API budget)
  const { data: facets } = useQuery<Facets>({
    queryKey: ["/api/clickup/workspaces", workspaceId, "facets"],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/facets`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    staleTime: 5 * 60_000,
  });

  // Saved presets
  const { data: presetsData, refetch: refetchPresets } = useQuery<{ presets: FilterPreset[] }>({
    queryKey: ["/api/clickup/filter-presets", workspaceId],
    queryFn: () =>
      fetch(`/api/clickup/filter-presets?workspace_id=${workspaceId}`, {
        credentials: "include",
      }).then((r) => r.json()),
    staleTime: 60_000,
  });
  const presets = presetsData?.presets ?? [];

  // Search results — only fires when committed changes
  const searchUrl = buildSearchUrl(workspaceId, committed, page);
  const {
    data: searchData,
    isFetching,
    isError,
    refetch: refetchSearch,
  } = useQuery<{ tasks: Task[]; last_page: boolean }>({
    queryKey: ["clickup-search", workspaceId, committed, page],
    queryFn: async () => {
      const res = await fetch(searchUrl, { credentials: "include" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Search failed (${res.status})`);
      }
      return res.json();
    },
    enabled: activeFilterCount(committed) > 0 || committed.includeClosed,
    retry: 2,
    retryDelay: 1500,
    meta: { silent: true },
  });

  // When page changes, fetch and append
  useEffect(() => {
    if (page === 0) {
      setAllTasks(searchData?.tasks ?? []);
    } else {
      setAllTasks((prev) => [...prev, ...(searchData?.tasks ?? [])]);
    }
  }, [searchData, page]);

  // When committed filters change, reset pagination
  useEffect(() => {
    setPage(0);
    setAllTasks([]);
  }, [committed]);

  function setFilter<K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function applyFilters() {
    setCommitted({ ...filters });
  }

  function clearAll() {
    setFilters(EMPTY_FILTERS);
    setCommitted(EMPTY_FILTERS);
    setAllTasks([]);
  }

  // Debounce text query: auto-apply 600ms after last keystroke
  function handleQueryChange(q: string) {
    setFilter("query", q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setCommitted((prev) => ({ ...prev, query: q }));
    }, 600);
  }

  function loadPreset(p: FilterPreset) {
    setFilters(p.filters);
    setCommitted(p.filters);
  }

  // Save preset mutation
  const saveMut = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/clickup/filter-presets", {
        name: presetName.trim(),
        workspaceId,
        filters: committed,
      }),
    onSuccess: () => {
      setSaveDialogOpen(false);
      setPresetName("");
      void refetchPresets(); // fire-and-forget: refetch only
      toast({ title: "Preset saved" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to save preset", description: e.message, variant: "destructive" }),
  });

  // Delete preset mutation
  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      apiRequest("DELETE", `/api/clickup/filter-presets/${id}`, {}),
    onSuccess: () => {
      void refetchPresets(); // fire-and-forget: refetch only
      toast({ title: "Preset deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Failed to delete preset", description: e.message, variant: "destructive" }),
  });

  const statusOptions = (facets?.statuses ?? []).map((s) => ({
    value: s.status,
    label: s.status,
  }));
  const memberOptions = (facets?.members ?? []).map((m) => ({
    value: m.id,
    label: m.username,
  }));
  const tagOptions = (facets?.tags ?? []).map((t) => ({ value: t.name, label: t.name }));
  const spaceOptions = spaces.filter((s) => !s.archived).map((s) => ({
    value: s.id,
    label: s.name,
  }));

  const hasActiveFilters = activeFilterCount(committed) > 0;
  const lastPage = searchData?.last_page ?? true;
  const isRunning = isFetching && page === 0;

  return (
    <div className="space-y-3" data-testid="panel-search">
      {/* Preset bar */}
      {presets.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="preset-bar">
          <span className="text-[11px] text-muted-foreground">Saved:</span>
          {presets.map((p) => (
            <div key={p.id} className="flex items-center gap-0.5">
              <button
                onClick={() => loadPreset(p)}
                className="text-[11px] px-2 py-0.5 rounded-l border border-r-0 border-border bg-card hover:bg-purple-50 text-foreground"
                data-testid={`preset-load-${p.id}`}
              >
                {p.name}
              </button>
              <button
                onClick={() => deleteMut.mutate(p.id)}
                disabled={deleteMut.isPending}
                className="text-[11px] px-1 py-0.5 rounded-r border border-border bg-card hover:bg-red-50 text-muted-foreground hover:text-red-500"
                data-testid={`preset-delete-${p.id}`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Search + filter bar */}
      <div className="bg-card border rounded-lg p-3 space-y-3" data-testid="search-filter-bar">
        {/* Text search */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={filters.query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder="Search tasks…"
              className="pl-8 h-8 text-xs"
              data-testid="input-search-query"
            />
          </div>
          <Button
            size="sm"
            onClick={applyFilters}
            data-testid="button-apply-filters"
            className="h-8"
          >
            {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAdvanced((v) => !v)}
            data-testid="button-toggle-advanced"
            className="h-8 gap-1"
          >
            <Filter className="w-3 h-3" />
            Filters
            {activeFilterCount(filters) > 0 && (
              <Badge className="text-[9px] px-1 py-0 ml-0.5">{activeFilterCount(filters)}</Badge>
            )}
          </Button>
          {hasActiveFilters && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSaveDialogOpen(true)}
                data-testid="button-save-preset"
                className="h-8"
                title="Save current filters as preset"
              >
                <BookmarkPlus className="w-3 h-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearAll}
                data-testid="button-clear-filters"
                className="h-8 text-muted-foreground hover:text-red-500"
                title="Clear all filters"
              >
                <X className="w-3 h-3" />
              </Button>
            </>
          )}
        </div>

        {/* Quick filters */}
        {showAdvanced && (
          <div className="space-y-3 pt-2 border-t" data-testid="advanced-filters">
            {statusOptions.length > 0 && (
              <MultiToggle
                options={statusOptions}
                selected={filters.statuses}
                onChange={(v) => setFilter("statuses", v)}
                label="Status"
                testId="filter-status"
              />
            )}

            <MultiToggle
              options={PRIORITY_OPTIONS}
              selected={filters.priorities}
              onChange={(v) => setFilter("priorities", v)}
              label="Priority"
              testId="filter-priority"
            />

            {memberOptions.length > 0 && (
              <MultiToggle
                options={memberOptions}
                selected={filters.assignees}
                onChange={(v) => setFilter("assignees", v)}
                label="Assignee"
                testId="filter-assignee"
              />
            )}

            {tagOptions.length > 0 && (
              <MultiToggle
                options={tagOptions}
                selected={filters.tags}
                onChange={(v) => setFilter("tags", v)}
                label="Tag"
                testId="filter-tag"
              />
            )}

            {spaceOptions.length > 0 && (
              <MultiToggle
                options={spaceOptions}
                selected={filters.spaceIds}
                onChange={(v) => setFilter("spaceIds", v)}
                label="Space"
                testId="filter-space"
              />
            )}

            {/* Date ranges */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Due after</Label>
                <Input
                  type="date"
                  value={filters.dueDateGt}
                  onChange={(e) => setFilter("dueDateGt", e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-due-date-gt"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Due before</Label>
                <Input
                  type="date"
                  value={filters.dueDateLt}
                  onChange={(e) => setFilter("dueDateLt", e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-due-date-lt"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Start after</Label>
                <Input
                  type="date"
                  value={filters.startDateGt}
                  onChange={(e) => setFilter("startDateGt", e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-start-date-gt"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Start before</Label>
                <Input
                  type="date"
                  value={filters.startDateLt}
                  onChange={(e) => setFilter("startDateLt", e.target.value)}
                  className="h-7 text-xs"
                  data-testid="input-start-date-lt"
                />
              </div>
            </div>

            {/* Include closed toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="include-closed"
                checked={filters.includeClosed}
                onChange={(e) => setFilter("includeClosed", e.target.checked)}
                className="w-3 h-3"
                data-testid="checkbox-include-closed"
              />
              <Label htmlFor="include-closed" className="text-xs text-muted-foreground cursor-pointer">
                Include closed tasks
              </Label>
            </div>

            {/* Custom field filters */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Custom field filters</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs text-purple-600 px-1"
                  onClick={() =>
                    setFilter("customFields", [
                      ...filters.customFields,
                      { field_id: "", operator: "=", value: "" },
                    ])
                  }
                  data-testid="button-add-custom-filter"
                >
                  <Plus className="w-3 h-3 mr-0.5" /> Add
                </Button>
              </div>
              {filters.customFields.map((cf, i) => (
                <div key={i} className="flex gap-1 items-center" data-testid={`custom-field-filter-${i}`}>
                  <Input
                    value={cf.field_id}
                    onChange={(e) => {
                      const updated = [...filters.customFields];
                      updated[i] = { ...updated[i], field_id: e.target.value };
                      setFilter("customFields", updated);
                    }}
                    placeholder="Field UUID"
                    className="h-7 text-xs flex-1"
                    data-testid={`input-cf-field-id-${i}`}
                  />
                  <Select
                    value={cf.operator}
                    onValueChange={(v) => {
                      const updated = [...filters.customFields];
                      updated[i] = { ...updated[i], operator: v };
                      setFilter("customFields", updated);
                    }}
                  >
                    <SelectTrigger className="h-7 text-xs w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CF_OPERATORS.map((op) => (
                        <SelectItem key={op} value={op} className="text-xs">
                          {op}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {cf.operator === "RANGE" ? (
                    <>
                      <Input
                        value={cf.rangeFrom ?? ""}
                        onChange={(e) => {
                          const updated = [...filters.customFields];
                          updated[i] = { ...updated[i], rangeFrom: e.target.value };
                          setFilter("customFields", updated);
                        }}
                        placeholder="From"
                        className="h-7 text-xs w-20"
                        data-testid={`input-cf-range-from-${i}`}
                      />
                      <Input
                        value={cf.rangeTo ?? ""}
                        onChange={(e) => {
                          const updated = [...filters.customFields];
                          updated[i] = { ...updated[i], rangeTo: e.target.value };
                          setFilter("customFields", updated);
                        }}
                        placeholder="To"
                        className="h-7 text-xs w-20"
                        data-testid={`input-cf-range-to-${i}`}
                      />
                    </>
                  ) : cf.operator !== "is null" && cf.operator !== "is not null" ? (
                    <Input
                      value={cf.value ?? ""}
                      onChange={(e) => {
                        const updated = [...filters.customFields];
                        updated[i] = { ...updated[i], value: e.target.value };
                        setFilter("customFields", updated);
                      }}
                      placeholder="Value"
                      className="h-7 text-xs w-24"
                      data-testid={`input-cf-value-${i}`}
                    />
                  ) : null}
                  <button
                    onClick={() => {
                      const updated = filters.customFields.filter((_, j) => j !== i);
                      setFilter("customFields", updated);
                    }}
                    className="text-muted-foreground hover:text-red-500"
                    data-testid={`button-remove-cf-${i}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>

            <Button
              size="sm"
              onClick={applyFilters}
              className="w-full h-7 text-xs"
              data-testid="button-apply-filters-advanced"
            >
              Apply filters
            </Button>
          </div>
        )}
      </div>

      {/* Error state — inline, no global toast */}
      {isError && !isFetching && (
        <div
          className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2"
          data-testid="search-error"
        >
          Search failed.{" "}
          <button
            className="underline ml-1"
            onClick={() => refetchSearch()}
            data-testid="button-retry-search"
          >
            Retry
          </button>
        </div>
      )}

      {/* Results */}
      {(allTasks.length > 0 || isFetching) && (
        <div className="space-y-1" data-testid="search-results">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {isFetching && page === 0 ? "Searching…" : `${allTasks.length} task${allTasks.length !== 1 ? "s" : ""}`}
              {!lastPage && !isFetching ? " (more available)" : ""}
            </p>
          </div>

          {isRunning ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : (
            allTasks.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 bg-card border rounded px-3 py-2 hover:bg-muted/50 cursor-pointer"
                onClick={() => setSelectedTask(t)}
                data-testid={`search-result-${t.id}`}
              >
                <CheckCircle
                  className={`w-4 h-4 flex-shrink-0 ${t.status?.type === "done" ? "text-green-500" : "text-gray-300"}`}
                />
                <span className="text-sm text-foreground flex-1 truncate">{t.name}</span>
                {t.status && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusColor(t.status)}`}
                  >
                    {t.status.status}
                  </span>
                )}
                {t.priority && (
                  <span className="text-[10px] text-muted-foreground">{priorityLabel(t.priority)}</span>
                )}
                {t.due_date && (
                  <span className="text-[10px] text-muted-foreground">{fmtDate(t.due_date)}</span>
                )}
                {t.url && (
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-gray-300 hover:text-purple-500"
                    data-testid={`link-result-external-${t.id}`}
                  >
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            ))
          )}

          {/* Load more */}
          {!lastPage && !isFetching && (
            <Button
              size="sm"
              variant="outline"
              className="w-full text-xs mt-1"
              onClick={() => setPage((p) => p + 1)}
              data-testid="button-load-more"
            >
              Load more
            </Button>
          )}
          {isFetching && page > 0 && (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}
        </div>
      )}

      {/* No-results state (not first load, no error, 0 tasks) */}
      {hasActiveFilters && !isFetching && !isError && allTasks.length === 0 && searchData !== undefined && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2" data-testid="search-empty">
          <Search className="w-6 h-6" />
          <p className="text-xs">No tasks match these filters</p>
        </div>
      )}

      {/* Prompt when no filters applied yet */}
      {!hasActiveFilters && allTasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground gap-2" data-testid="search-prompt">
          <Search className="w-6 h-6" />
          <p className="text-xs">Enter a search term or apply filters to find tasks</p>
        </div>
      )}

      {/* Task detail dialog reused from list view */}
      <TaskDetailDialog
        task={selectedTask}
        workspaceId={workspaceId}
        spaceId={null}
        onClose={() => setSelectedTask(null)}
      />

      {/* Save preset dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-sm" data-testid="dialog-save-preset">
          <DialogHeader>
            <DialogTitle className="text-sm">Save filter preset</DialogTitle>
            <DialogDescription className="text-xs">
              Give this set of filters a name so you can re-run it in one click.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Preset name…"
            className="text-xs h-8"
            data-testid="input-preset-name"
            onKeyDown={(e) => {
              if (e.key === "Enter" && presetName.trim()) saveMut.mutate();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSaveDialogOpen(false)}
              data-testid="button-cancel-preset"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending || !presetName.trim()}
              data-testid="button-confirm-save-preset"
            >
              {saveMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

