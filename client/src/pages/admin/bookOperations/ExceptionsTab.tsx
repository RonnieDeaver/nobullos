/**
 * Book Operations — Exceptions tab.
 * Lists BookOperationException items from the union query.
 * Kind values: all | payments | ghl | analytics | delivery
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
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
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, CheckCircle2, RotateCcw } from "lucide-react";

import type {
  BookOpsException,
  BookOpsExceptionsResult,
  ExceptionKindFilter,
} from "./types";
import { EXCEPTION_KIND_OPTIONS } from "./types";
import { ExcSourceBadge, StatusBadge } from "./shared";
import { fmtDate, capitalize, genIdempotencyKey } from "./utils";

const PAGE_SIZE = 50;

export function ExceptionsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [kindFilter, setKindFilter] = useState<ExceptionKindFilter>("all");
  const [offset, setOffset] = useState(0);

  const repairMutation = useMutation({
    mutationFn: async (exception: BookOpsException) => {
      const idempotencyKey = genIdempotencyKey();
      if (exception.source === "checkout_payment" && exception.repairTargetId) {
        return apiRequest(
          "POST",
          `/api/admin/book-operations/payment-events/${encodeURIComponent(exception.repairTargetId)}/retry`,
          { idempotencyKey },
        );
      }
      if (exception.source === "ghl_outbox" && exception.repairTargetId) {
        return apiRequest(
          "POST",
          `/api/admin/book-operations/outbox/${encodeURIComponent(exception.repairTargetId)}/replay`,
          { idempotencyKey },
        );
      }
      if (exception.source === "delivery_audit" && exception.repairTargetId) {
        return apiRequest(
          "POST",
          `/api/admin/book-delivery/entitlements/${encodeURIComponent(exception.repairTargetId)}/resend`,
          { idempotencyKey },
        );
      }
      throw new Error("This exception has no eligible safe repair.");
    },
    onSuccess: async (_response, exception) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/admin/book-operations/exceptions"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/admin/book-operations/records"],
        }),
      ]);
      toast({
        title:
          exception.source === "checkout_payment"
            ? "Reconciliation retry recorded"
            : exception.source === "ghl_outbox"
              ? "GHL replay queued"
              : "Access resend queued",
        description: "The command was attributed to your operator account.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Repair was not applied",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  function repairCopy(exception: BookOpsException): {
    label: string;
    title: string;
    description: string;
  } | null {
    if (!exception.repairTargetId) return null;
    if (exception.source === "checkout_payment") {
      return {
        label: "Retry",
        title: "Retry local payment reconciliation?",
        description:
          "This reprocesses the persisted verified payment event. It does not charge a card or mark an order paid.",
      };
    }
    if (exception.source === "ghl_outbox") {
      return {
        label: "Replay",
        title: "Replay this GHL sync event?",
        description:
          "This requeues the failed event through the existing relay. It cannot edit a GHL sales record directly.",
      };
    }
    if (exception.source === "delivery_audit") {
      return {
        label: "Resend",
        title: "Resend purchased access?",
        description:
          "This resends access for the existing purchased entitlement. It cannot grant an unpurchased product.",
      };
    }
    return null;
  }

  const { data, isLoading, isError, isFetching } = useQuery<BookOpsExceptionsResult>({
    queryKey: ["/api/admin/book-operations/exceptions", kindFilter, offset],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("kind", kindFilter);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      return apiRequest(
        "GET",
        `/api/admin/book-operations/exceptions?${params.toString()}`,
      ).then((r) => r.json());
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={kindFilter}
          onValueChange={(v) => {
            setKindFilter(v as ExceptionKindFilter);
            setOffset(0);
          }}
        >
          <SelectTrigger className="h-9 w-[200px]">
            <SelectValue placeholder="All kinds" />
          </SelectTrigger>
          <SelectContent>
            {EXCEPTION_KIND_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isFetching && !isLoading && (
          <Spinner className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {total.toLocaleString()} exception{total !== 1 ? "s" : ""}
        </span>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner className="h-5 w-5" /> Loading exceptions…
          </CardContent>
        </Card>
      ) : isError ? (
        <Card accent="critical">
          <CardContent className="flex items-center gap-2 py-4 text-sm text-red-700 dark:text-red-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Failed to load exception queue. The API may be unavailable.
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<CheckCircle2 />}
              title="No exceptions in queue"
              description="No book operation exceptions match the current filter."
              hint={
                kindFilter === "all"
                  ? "Exceptions appear here when payment, outbox, analytics, or delivery operations fail."
                  : "Try a different exception kind filter."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50 dark:bg-slate-800/30">
                  <TableHead className="whitespace-nowrap">Source</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="w-[30%]">Reason / Detail</TableHead>
                  <TableHead className="hidden md:table-cell">Provider</TableHead>
                  <TableHead className="hidden md:table-cell whitespace-nowrap">Entity</TableHead>
                  <TableHead className="hidden lg:table-cell whitespace-nowrap">Created</TableHead>
                  <TableHead className="hidden lg:table-cell whitespace-nowrap">Updated</TableHead>
                  <TableHead>Status</TableHead>
                   <TableHead className="text-right">Safe action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                 {items.map((exc) => {
                   const repair = repairCopy(exc);
                   return (
                   <TableRow key={`${exc.source}-${exc.entityId}`} data-testid={`row-exc-${exc.entityId}`}>
                    <TableCell>
                      <ExcSourceBadge source={exc.source} />
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {exc.exceptionKind}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <p className="text-sm truncate" title={exc.reason ?? undefined}>
                        {exc.reason ?? <span className="text-muted-foreground">—</span>}
                      </p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {exc.providerOrPlatform ?? "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="space-y-0.5">
                        <p className="text-xs text-muted-foreground">{capitalize(exc.entityType)}</p>
                        <code className="text-xs text-muted-foreground font-mono break-all">
                          {exc.localReferenceId ?? exc.entityId}
                        </code>
                      </div>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDate(exc.createdAt)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDate(exc.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={exc.status} />
                    </TableCell>
                     <TableCell className="text-right">
                       {repair ? (
                         <ConfirmActionDialog
                           trigger={
                             <Button
                               type="button"
                               variant="outline"
                               size="sm"
                               disabled={repairMutation.isPending}
                             >
                               <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                               {repair.label}
                             </Button>
                           }
                           title={repair.title}
                           description={repair.description}
                           confirmLabel={repair.label}
                           onConfirm={() => repairMutation.mutate(exc)}
                           testId={`dialog-repair-${exc.entityId}`}
                         />
                       ) : (
                         <span className="text-xs text-muted-foreground">Inspect only</span>
                       )}
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
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages} · {total.toLocaleString()} exceptions
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
  );
}
