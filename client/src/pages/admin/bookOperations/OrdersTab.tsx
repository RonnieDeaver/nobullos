/**
 * Book Operations — Orders & Support tab.
 * Lists BookOperationListItem rows, search/filter/paginate, opens RecordDetail.
 */
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/kit/EmptyState";
import { Search, BookOpen, AlertCircle, ChevronRight } from "lucide-react";

import type { BookOpsListResult, RecordStatusFilter } from "./types";
import { RECORD_STATUS_OPTIONS } from "./types";
import { StatusBadge } from "./shared";
import { RecordDetail } from "./RecordDetail";
import { fmtCurrency, fmtDate } from "./utils";

const PAGE_SIZE = 25;

export function OrdersTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<RecordStatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleSearchChange(v: string) {
    setSearch(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(v);
      setOffset(0);
    }, 350);
  }

  const { data, isLoading, isError, isFetching } = useQuery<BookOpsListResult>({
    queryKey: ["/api/admin/book-operations/records", debouncedSearch, statusFilter, offset],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("status", statusFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      return apiRequest("GET", `/api/admin/book-operations/records?${params.toString()}`).then(
        (r) => r.json(),
      );
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  // The anchor ID for detail: prefer checkoutSessionId, then orderId, then contactId
  function getDetailId(item: (typeof items)[number]): string | null {
    return item.checkoutSessionId ?? item.orderId ?? item.contactId ?? null;
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search records"
            placeholder="Order #, checkout ID…"
            className="h-9 pl-8"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v as RecordStatusFilter);
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-9 w-[170px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {RECORD_STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isFetching && !isLoading && <Spinner className="h-4 w-4 text-muted-foreground" />}
      </div>

      {/* Table + detail split */}
      <div className={`grid gap-4 ${selectedId ? "lg:grid-cols-[1fr_400px]" : ""}`}>
        {/* Table */}
        <div className="min-w-0">
          {isLoading ? (
            <Card>
              <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Spinner className="h-5 w-5" /> Loading records…
              </CardContent>
            </Card>
          ) : isError ? (
            <Card accent="critical">
              <CardContent className="flex items-center gap-2 py-4 text-sm text-red-700 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Failed to load records. The API may be unavailable.
              </CardContent>
            </Card>
          ) : items.length === 0 ? (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={<BookOpen />}
                  title="No records found"
                  description="No book operation records match the current filters."
                  hint="Try adjusting the search term or status filter."
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50 dark:bg-slate-800/30">
                      <TableHead className="w-[30%]">Contact</TableHead>
                      <TableHead>Order</TableHead>
                      <TableHead className="hidden md:table-cell">Package</TableHead>
                      <TableHead className="hidden md:table-cell">Amount</TableHead>
                      <TableHead className="hidden lg:table-cell">Created</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const detailId = getDetailId(item);
                      const isSelected = detailId !== null && selectedId === detailId;
                      return (
                        <TableRow
                          key={item.checkoutSessionId ?? item.orderId ?? item.contactId ?? Math.random()}
                          className={`cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/30 ${
                            isSelected ? "bg-slate-50 dark:bg-slate-800/30" : ""
                          }`}
                          onClick={() => setSelectedId(isSelected ? null : (detailId ?? null))}
                          data-testid={`row-record-${detailId}`}
                        >
                          <TableCell>
                            <div>
                              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                                {item.contactNameMasked ?? "—"}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {item.contactEmailMasked ?? "—"}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-0.5">
                              {item.orderNumber ? (
                                <p className="text-sm font-medium">{item.orderNumber}</p>
                              ) : (
                                <p className="text-xs text-muted-foreground">No order</p>
                              )}
                              <StatusBadge status={item.orderStatus ?? item.checkoutStatus} />
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            {item.checkoutPackageCode ?? "—"}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            {fmtCurrency(item.orderTotalCents)}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                            {fmtDate(item.createdAt)}
                          </TableCell>
                          <TableCell>
                            <ChevronRight
                              className={`h-4 w-4 text-muted-foreground transition-transform ${
                                isSelected ? "rotate-90" : ""
                              }`}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <span>
                Page {currentPage} of {totalPages} · {total.toLocaleString()} records
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedId && (
          <Card>
            <CardContent className="overflow-y-auto px-4 pb-4 pt-4 max-h-[80vh]">
              <RecordDetail recordId={selectedId} onClose={() => setSelectedId(null)} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
