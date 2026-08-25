import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Mail, Briefcase, XCircle, Ban, AlertTriangle } from "lucide-react";
import { InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import type {
  BulkAction, BulkSelection, ClientLite, FilterState,
  FrontInbox, MessageFeedResponse,
} from "./types";
import { DEFAULT_FILTERS } from "./types";
import { MessageRow } from "./MessageRow";
import { BulkActionModal } from "./BulkActionModal";
import { PercentText } from "./PercentText";

export function FrontMessagesTab() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);

  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setPage(1);
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  };

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  };

  const toggleSelected = (id: string, next: boolean, currentPageIds: string[]) => {
    if (selectAllMatching && !next) {
      const seeded = new Set<string>(currentPageIds);
      seeded.delete(id);
      setSelectedIds(seeded);
      setSelectAllMatching(false);
      return;
    }
    setSelectedIds(prev => {
      const updated = new Set(prev);
      if (next) updated.add(id);
      else updated.delete(id);
      return updated;
    });
    if (next === false) setSelectAllMatching(false);
  };

  const queryParams = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (filters.match !== "all") params.set("match", filters.match);
    if (filters.search.trim()) params.set("search", filters.search.trim());
    if (filters.senderEmail.trim()) params.set("senderEmail", filters.senderEmail.trim());
    if (filters.senderDomain.trim()) params.set("senderDomain", filters.senderDomain.trim());
    if (filters.inbox !== "all") params.set("inbox", filters.inbox);
    if (filters.client !== "all") params.set("clientId", filters.client);
    if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
    if (filters.dateTo) params.set("dateTo", filters.dateTo);
    return params.toString();
  }, [page, filters]);

  const { data, isLoading, error } = useQuery<MessageFeedResponse>({
    queryKey: ["/api/integrations/front/messages", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/front/messages?${queryParams}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Failed to load Front messages");
      }
      return res.json();
    },
  });

  const { data: inboxes = [] } = useQuery<FrontInbox[]>({
    queryKey: ["/api/integrations/front/inboxes"],
    queryFn: async () => {
      const res = await fetch(`/api/integrations/front/inboxes`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: clients = [] } = useQuery<ClientLite[]>({
    queryKey: ["/api/clients"],
    queryFn: async () => {
      const res = await fetch(`/api/clients`, { credentials: "include" });
      if (!res.ok) return [];
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const clientOptions = useMemo(() => {
    return clients
      .map(c => ({ value: c.id, label: c.firmName || c.name || c.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [clients]);

  const inboxOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: Array<{ value: string; label: string }> = [];
    for (const inbox of inboxes) {
      const addr = (inbox.send_as || inbox.address || "").toLowerCase().trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      opts.push({ value: addr, label: `${inbox.name || addr} (${addr})` });
    }
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [inboxes]);

  const messages = useMemo(() => data?.messages || [], [data?.messages]);
  const pageIds = useMemo(() => messages.map(m => m.id), [messages]);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const someOnPageSelected = pageIds.some(id => selectedIds.has(id));

  const togglePageSelection = (checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) {
        for (const id of pageIds) next.add(id);
      } else {
        for (const id of pageIds) next.delete(id);
      }
      return next;
    });
    setSelectAllMatching(false);
  };

  const querySnapshot = useMemo<Record<string, string>>(() => {
    const snap: Record<string, string> = {};
    if (filters.match !== "all") snap.match = filters.match;
    if (filters.search.trim()) snap.search = filters.search.trim();
    if (filters.senderEmail.trim()) snap.senderEmail = filters.senderEmail.trim();
    if (filters.senderDomain.trim()) snap.senderDomain = filters.senderDomain.trim();
    if (filters.inbox !== "all") snap.inbox = filters.inbox;
    if (filters.client !== "all") snap.clientId = filters.client;
    if (filters.dateFrom) snap.dateFrom = filters.dateFrom;
    if (filters.dateTo) snap.dateTo = filters.dateTo;
    return snap;
  }, [filters]);

  const totalMatching = data?.pagination.total ?? 0;
  const selectionCount = selectAllMatching ? totalMatching : selectedIds.size;
  const bulkSelection: BulkSelection = selectAllMatching
    ? { mode: "query", query: querySnapshot }
    : { mode: "ids", messageIds: Array.from(selectedIds) };
  const bulkSelectionLabel = selectAllMatching
    ? `All ${totalMatching} messages matching the current filter.`
    : `${selectedIds.size} selected message${selectedIds.size === 1 ? "" : "s"}.`;

  const activeFilters: Array<{ key: keyof FilterState; label: string }> = [];
  if (filters.search.trim()) activeFilters.push({ key: "search", label: `Search: "${filters.search.trim()}"` });
  if (filters.senderEmail.trim()) activeFilters.push({ key: "senderEmail", label: `Sender: ${filters.senderEmail.trim()}` });
  if (filters.senderDomain.trim()) activeFilters.push({ key: "senderDomain", label: `Domain: ${filters.senderDomain.trim()}` });
  if (filters.inbox !== "all") {
    const labelMatch = inboxOptions.find(o => o.value === filters.inbox);
    activeFilters.push({ key: "inbox", label: `Inbox: ${labelMatch?.label || filters.inbox}` });
  }
  if (filters.client !== "all") {
    const clientMatch = clientOptions.find(o => o.value === filters.client);
    activeFilters.push({ key: "client", label: `Client: ${clientMatch?.label || filters.client}` });
  }
  if (filters.match !== "all") activeFilters.push({ key: "match", label: `Status: ${filters.match}` });
  if (filters.dateFrom) activeFilters.push({ key: "dateFrom", label: `From: ${filters.dateFrom}` });
  if (filters.dateTo) activeFilters.push({ key: "dateTo", label: `To: ${filters.dateTo}` });

  return (
    <Card data-testid="section-front-messages">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg sm:text-2xl">
          <Mail className="w-5 h-5 text-blue-600" />
          Messages browser
        </CardTitle>
        <p className="text-xs text-gray-500 mt-1" data-testid="text-messages-subtitle">
          Filter, inspect, and act on individual Front messages. Stats below
          reflect the current filter; global counts live in the KPI strip above and the Pipeline Health and Jobs tabs.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="bg-gray-50 rounded p-3" data-testid="stat-total">
            <p className="text-gray-500">Total <span className="text-xs uppercase tracking-wide text-gray-400">(for current filter)</span></p>
            <p className="text-2xl font-semibold">{data?.filteredStats.total ?? 0}</p>
          </div>
          <div className="bg-green-50 rounded p-3" data-testid="stat-matched">
            <p className="text-gray-500">Matched <span className="text-xs uppercase tracking-wide text-gray-400">(for current filter)</span></p>
            <p className="text-2xl font-semibold text-green-700">{data?.filteredStats.matched ?? 0}</p>
          </div>
          <div className="bg-gray-50 rounded p-3" data-testid="stat-unmatched">
            <p className="text-gray-500">Unmatched <span className="text-xs uppercase tracking-wide text-gray-400">(for current filter)</span></p>
            <p className="text-2xl font-semibold text-gray-600">{data?.filteredStats.unmatched ?? 0}</p>
          </div>
          <div className="bg-blue-50 rounded p-3" data-testid="stat-rate">
            <p className="text-gray-500">Match Rate <span className="text-xs uppercase tracking-wide text-gray-400">(for current filter)</span></p>
            <p className="text-2xl font-semibold text-blue-700"><PercentText value={data?.filteredStats.matchRate ?? 0} digits={0} /></p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search subject, preview or participant…"
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="w-64"
            data-testid="input-front-search"
          />
          <Input
            placeholder="Sender email"
            value={filters.senderEmail}
            onChange={(e) => updateFilter("senderEmail", e.target.value)}
            className="w-56"
            data-testid="input-front-sender-email"
          />
          <Input
            placeholder="Sender domain (e.g. acme.com)"
            value={filters.senderDomain}
            onChange={(e) => updateFilter("senderDomain", e.target.value)}
            className="w-56"
            data-testid="input-front-sender-domain"
          />
          <Select value={filters.inbox} onValueChange={(v) => updateFilter("inbox", v)}>
            <SelectTrigger className="w-56" data-testid="select-front-inbox">
              <SelectValue placeholder="All inboxes" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All inboxes</SelectItem>
              {inboxOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.client} onValueChange={(v) => updateFilter("client", v)}>
            <SelectTrigger className="w-56" data-testid="select-front-client">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clientOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value} data-testid={`option-front-client-${opt.value}`}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.match} onValueChange={(v) => updateFilter("match", v)}>
            <SelectTrigger className="w-44" data-testid="select-front-match-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="matched">Matched</SelectItem>
              <SelectItem value="unmatched">Unmatched</SelectItem>
              <SelectItem value="dismissed">Dismissed</SelectItem>
              <SelectItem value="blocked">Blocked</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={filters.dateFrom}
            onChange={(e) => updateFilter("dateFrom", e.target.value)}
            className="w-40"
            data-testid="input-front-date-from"
          />
          <Input
            type="date"
            value={filters.dateTo}
            onChange={(e) => updateFilter("dateTo", e.target.value)}
            className="w-40"
            data-testid="input-front-date-to"
          />
        </div>

        {activeFilters.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="filters-in-effect">
            <span className="text-gray-500">Filters:</span>
            {activeFilters.map(f => (
              <Badge key={f.key} variant="outline" className="bg-gray-50" data-testid={`active-filter-${f.key}`}>
                {f.label}
              </Badge>
            ))}
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clearFilters} data-testid="button-clear-front-filters">
              Clear all
            </Button>
          </div>
        )}

        {messages.length > 0 && (
          <div
            className="flex items-center gap-3 flex-wrap text-sm border rounded p-2 bg-gray-50/60"
            data-testid="bulk-selection-bar"
          >
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all-page"
                checked={allOnPageSelected ? true : someOnPageSelected ? "indeterminate" : false}
                onCheckedChange={(v) => togglePageSelection(v === true)}
                data-testid="checkbox-front-select-all-page"
              />
              <Label htmlFor="select-all-page" className="cursor-pointer text-xs">
                Select page ({pageIds.length})
              </Label>
            </div>
            {selectionCount > 0 && (
              <span className="text-xs text-gray-600" data-testid="text-selection-count">
                {selectionCount} selected
              </span>
            )}
            {selectedIds.size > 0 && !selectAllMatching && totalMatching > selectedIds.size && (
              <button
                type="button"
                className="text-xs text-blue-700 underline"
                onClick={() => setSelectAllMatching(true)}
                data-testid="button-front-select-all-matching"
              >
                Select all {totalMatching} matching this filter
              </button>
            )}
            {selectAllMatching && (
              <button
                type="button"
                className="text-xs text-blue-700 underline"
                onClick={() => { setSelectAllMatching(false); setSelectedIds(new Set()); }}
                data-testid="button-front-clear-select-all"
              >
                Clear filter selection
              </button>
            )}
            {selectionCount > 0 && (
              <div className="flex flex-wrap gap-2 ml-auto" data-testid="toolbar-bulk-actions">
                <Button size="sm" variant="outline" onClick={() => setBulkAction("assign")} data-testid="button-front-bulk-assign">
                  <Briefcase className="w-3.5 h-3.5 mr-1.5" />Assign
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkAction("dismiss")} data-testid="button-front-bulk-dismiss">
                  <XCircle className="w-3.5 h-3.5 mr-1.5" />Dismiss
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkAction("block_sender")} data-testid="button-front-bulk-block">
                  <Ban className="w-3.5 h-3.5 mr-1.5" />Block sender
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkAction("block_domain")} data-testid="button-front-bulk-block-domain">
                  <Ban className="w-3.5 h-3.5 mr-1.5" />Block domain
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkAction("not_a_match")} data-testid="button-front-bulk-not-match">
                  <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />Not a match
                </Button>
              </div>
            )}
          </div>
        )}

        {error ? (
          <div className="text-center py-8 text-red-600" data-testid="error-state">
            {(error as Error).message}
          </div>
        ) : isLoading ? (
          <InlineLoadingSkeleton />
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-gray-500" data-testid="empty-state">
            {activeFilters.length > 0 ? "No messages match these filters." : "No Front messages found."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div className="space-y-2 min-w-[640px]">
              {messages.map(m => (
                <MessageRow
                  key={m.id}
                  msg={m}
                  isExpanded={expandedId === m.id}
                  onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
                  selected={selectAllMatching || selectedIds.has(m.id)}
                  onToggleSelected={(next) => toggleSelected(m.id, next, messages.map(x => x.id))}
                  clientOptions={clientOptions}
                />
              ))}
            </div>
          </div>
        )}

        {bulkAction && (
          <BulkActionModal
            open={true}
            onOpenChange={(v) => { if (!v) setBulkAction(null); }}
            action={bulkAction}
            selection={bulkSelection}
            selectionLabel={bulkSelectionLabel}
            clientOptions={clientOptions}
            onCompleted={() => {
              setSelectedIds(new Set());
              setSelectAllMatching(false);
              void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/messages"] }); // fire-and-forget: cache refresh only
              void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }); // fire-and-forget: cache refresh only
              void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/filter-rules"] }); // fire-and-forget: cache refresh only
            }}
          />
        )}

        {data && data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <p className="text-sm text-gray-500" data-testid="text-pagination">
              Page {data.pagination.page} of {data.pagination.totalPages} ({data.pagination.total} total)
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                data-testid="button-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => setPage(p => p + 1)}
                data-testid="button-next"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
