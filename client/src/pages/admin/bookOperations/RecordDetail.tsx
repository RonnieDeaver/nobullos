/**
 * Book Operations — Record detail panel.
 *
 * Shows BookOperationDetail fields and derives eligible actions from
 * each sub-array row (payment events, outbox entries, entitlements).
 *
 * Authority boundary: payment state is READ-ONLY here. No new entitlements
 * are granted. SMS consent and GHL sales records are not exposed.
 * Revoke requires a human-entered non-empty reason.
 */
import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { EmptyState } from "@/components/kit/EmptyState";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  Shield,
  RotateCcw,
  RefreshCw,
  PackageCheck,
  Zap,
  XCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import type { BookOpsDetail, BookOpsPaymentEventRef, BookOpsOutboxState, BookOpsEntitlement } from "./types";
import { StatusBadge, DetailField } from "./shared";
import { genIdempotencyKey, fmtCurrency, fmtDate, capitalize } from "./utils";

// ─── Action kinds ─────────────────────────────────────────────────────────────

type ActionKind = "retry-payment" | "replay-outbox" | "resend-delivery" | "reissue-delivery" | "revoke-entitlement";

interface PendingAction {
  kind: ActionKind;
  label: string;
  description: string;
  idempotencyKey: string;
  // For replay/retry — which entity
  entityId: string;
  // For revoke — must be human-entered
  revokeReason?: string;
}

// ─── Revoke reason modal ──────────────────────────────────────────────────────

function RevokeReasonStep({
  entitlementId,
  onConfirm,
  onCancel,
}: {
  entitlementId: string;
  onConfirm: (reason: string, idempotencyKey: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const ikey = useState(() => genIdempotencyKey())[0];
  const invalid = reason.trim().length < 3;

  return (
    <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md bg-card border shadow-lg p-6 space-y-4">
        <h2 className="font-semibold text-base">Revoke Entitlement</h2>
        <p className="text-sm text-muted-foreground">
          You are about to revoke entitlement{" "}
          <code className="text-xs">{entitlementId}</code>. This is logged and audited.
          You must provide a reason — it will be stored against the entitlement record.
        </p>
        <div>
          <label htmlFor="revoke-reason" className="text-xs font-medium text-muted-foreground">
            Revocation reason <span className="text-red-500">*</span>
          </label>
          <textarea
            id="revoke-reason"
            className="mt-1 w-full rounded border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            rows={3}
            placeholder="Enter a clear, specific reason for revoking this entitlement…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {reason.trim().length > 0 && invalid && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              Reason must be at least 3 characters.
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Idempotency key: <code className="text-xs">{ikey}</code>
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={invalid}
            onClick={() => onConfirm(reason.trim(), ikey)}
          >
            Revoke
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Payment events sub-section ───────────────────────────────────────────────

function PaymentEventsSection({
  events,
  onRetry,
  isPending,
}: {
  events: BookOpsPaymentEventRef[];
  onRetry: (id: string) => void;
  isPending: boolean;
}) {
  if (!events.length) return null;
  // An event is eligible for retry if it has no processedAt (unprocessed)
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Payment Events
      </p>
      <ul className="space-y-2">
        {events.map((pe) => {
          const eligible = pe.processedAt == null;
          return (
            <li key={pe.id} className="rounded border px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{capitalize(pe.eventType)}</span>
                    <Badge variant="outline" className="text-xs">{pe.provider}</Badge>
                  </div>
                  {pe.amountCents != null && (
                    <p className="text-muted-foreground">
                      {fmtCurrency(pe.amountCents)} {pe.currency ?? ""}
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    {eligible ? (
                      <span className="text-amber-600 dark:text-amber-400">Unprocessed</span>
                    ) : (
                      `Processed ${fmtDate(pe.processedAt)}`
                    )}
                  </p>
                  <p className="text-muted-foreground font-mono">{pe.id}</p>
                  {pe.providerEventId && (
                    <p className="text-muted-foreground">
                      Provider event:{" "}
                      <code className="font-mono break-all">{pe.providerEventId}</code>
                    </p>
                  )}
                </div>
                {eligible && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs"
                    disabled={isPending}
                    onClick={() => onRetry(pe.id)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Outbox entries sub-section ───────────────────────────────────────────────

function OutboxSection({
  entries,
  onReplay,
  isPending,
}: {
  entries: BookOpsOutboxState[];
  onReplay: (id: string) => void;
  isPending: boolean;
}) {
  if (!entries.length) return null;
  // Eligible for replay: failed or dead_letter
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        GHL Outbox Entries
      </p>
      <ul className="space-y-2">
        {entries.map((ob) => {
          const eligible = ob.status === "failed" || ob.status === "dead_letter";
          return (
            <li key={ob.id} className="rounded border px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{capitalize(ob.eventType)}</span>
                    <StatusBadge status={ob.status} />
                  </div>
                  <p className="text-muted-foreground">
                    {ob.attemptCount}/{ob.maxAttempts} attempts
                    {ob.nextRetryAt && ` · next retry ${fmtDate(ob.nextRetryAt)}`}
                  </p>
                  <p className="text-muted-foreground font-mono">{ob.id}</p>
                  <p className="text-muted-foreground">
                    Source: {ob.sourceType}{" "}
                    <code className="font-mono break-all">{ob.sourceId}</code>
                  </p>
                </div>
                {eligible && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs"
                    disabled={isPending}
                    onClick={() => onReplay(ob.id)}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Replay
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Entitlements sub-section ─────────────────────────────────────────────────

function EntitlementsSection({
  entitlements,
  onResend,
  onReissue,
  onRevoke,
  isPending,
}: {
  entitlements: BookOpsEntitlement[];
  onResend: (id: string) => void;
  onReissue: (id: string) => void;
  onRevoke: (id: string) => void;
  isPending: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (!entitlements.length) return null;

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Entitlements
      </p>
      <ul className="space-y-2">
        {entitlements.map((ent) => {
          const isActive = ent.status === "active";
          const isExpanded = expandedId === ent.id;
          return (
            <li key={ent.id} className="rounded border px-3 py-2 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{ent.packageCode}</span>
                    <StatusBadge status={ent.status} />
                    <span className="text-muted-foreground">{ent.entitlementCode}</span>
                  </div>
                  <p className="text-muted-foreground">
                    Granted {fmtDate(ent.grantedAt)}
                    {ent.revokedAt && (
                      <span className="ml-2 text-red-600 dark:text-red-400">
                        · Revoked {fmtDate(ent.revokedAt)}
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-muted-foreground">{ent.id}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-1 items-end">
                  {isActive && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        disabled={isPending}
                        onClick={() => onResend(ent.id)}
                      >
                        <PackageCheck className="h-3 w-3 mr-1" />
                        Resend delivery
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        disabled={isPending}
                        onClick={() => onReissue(ent.id)}
                      >
                        <Zap className="h-3 w-3 mr-1" />
                        Reissue delivery
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="text-xs h-7"
                        disabled={isPending}
                        onClick={() => onRevoke(ent.id)}
                      >
                        <XCircle className="h-3 w-3 mr-1" />
                        Revoke
                      </Button>
                    </>
                  )}
                  {ent.deliveryAudit.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setExpandedId(isExpanded ? null : ent.id)}
                    >
                      {isExpanded ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
                      Delivery log ({ent.deliveryAudit.length})
                    </Button>
                  )}
                </div>
              </div>
              {isExpanded && (
                <ol className="mt-2 space-y-1 border-t pt-2">
                  {ent.deliveryAudit.map((a) => (
                    <li key={a.id} className="flex items-start gap-2">
                      <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
                      <div>
                        <span className="font-medium">{capitalize(a.eventType)}</span>
                        {" · "}
                        <span className={a.outcome === "failed" || a.outcome === "unavailable" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
                          {capitalize(a.outcome)}
                        </span>
                        <span className="ml-2 text-muted-foreground">{fmtDate(a.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function RecordDetail({
  recordId,
  onClose,
}: {
  recordId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<BookOpsDetail>({
    queryKey: ["/api/admin/book-operations/records", recordId],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/admin/book-operations/records/${encodeURIComponent(recordId)}`,
      ).then((r) => r.json()),
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async (action: PendingAction) => {
      switch (action.kind) {
        case "retry-payment":
          return apiRequest(
            "POST",
            `/api/admin/book-operations/payment-events/${encodeURIComponent(action.entityId)}/retry`,
            { idempotencyKey: action.idempotencyKey },
          );
        case "replay-outbox":
          return apiRequest(
            "POST",
            `/api/admin/book-operations/outbox/${encodeURIComponent(action.entityId)}/replay`,
            { idempotencyKey: action.idempotencyKey },
          );
        case "resend-delivery":
          return apiRequest(
            "POST",
            `/api/admin/book-delivery/entitlements/${encodeURIComponent(action.entityId)}/resend`,
            { idempotencyKey: action.idempotencyKey },
          );
        case "reissue-delivery":
          return apiRequest(
            "POST",
            `/api/admin/book-delivery/entitlements/${encodeURIComponent(action.entityId)}/reissue`,
            { idempotencyKey: action.idempotencyKey },
          );
        case "revoke-entitlement":
          return apiRequest(
            "POST",
            `/api/admin/book-delivery/entitlements/${encodeURIComponent(action.entityId)}/revoke`,
            { idempotencyKey: action.idempotencyKey, reason: action.revokeReason! },
          );
      }
    },
    onSuccess: (_data, action) => {
      toast({ title: "Action queued", description: `${action.label} submitted.` });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/book-operations/records"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/book-operations/exceptions"] });
      setPendingAction(null);
    },
    onError: (err: Error) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
      setPendingAction(null);
    },
  });

  const confirm = useCallback(() => {
    if (!pendingAction) return;
    mutation.mutate(pendingAction);
  }, [pendingAction, mutation]);

  const isPending = mutation.isPending;

  function queueAction(kind: ActionKind, label: string, description: string, entityId: string) {
    setPendingAction({ kind, label, description, idempotencyKey: genIdempotencyKey(), entityId });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" /> Loading record…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        <AlertCircle className="mx-auto mb-2 h-6 w-6" />
        Failed to load record.
        <button className="ml-2 text-primary underline" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      {/* Revoke reason step (not a mutation confirm — needs human input first) */}
      {revokeTargetId && (
        <RevokeReasonStep
          entitlementId={revokeTargetId}
          onConfirm={(reason, ikey) => {
            setRevokeTargetId(null);
            setPendingAction({
              kind: "revoke-entitlement",
              label: "Revoke Entitlement",
              description: `Revoke entitlement ${revokeTargetId}. This is logged and audited.`,
              idempotencyKey: ikey,
              entityId: revokeTargetId,
              revokeReason: reason,
            });
          }}
          onCancel={() => setRevokeTargetId(null)}
        />
      )}

      {/* Standard confirm dialog for all other actions */}
      {pendingAction && (
        <ConfirmActionDialog
          open={true}
          onOpenChange={(o) => { if (!o && !isPending) setPendingAction(null); }}
          title={pendingAction.label}
          description={
            <span>
              {pendingAction.description}
              <br />
              <br />
              <strong>Idempotency key:</strong>{" "}
              <code className="text-xs break-all">{pendingAction.idempotencyKey}</code>
              <br />
              <span className="text-xs text-muted-foreground">
                This key is generated in your browser and ensures the action is not applied twice.
              </span>
            </span>
          }
          confirmLabel={isPending ? "Submitting…" : pendingAction.label}
          onConfirm={confirm}
          testId="dlg-confirm-bops-action"
        />
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{data.contactNameMasked ?? "—"}</p>
          <p className="text-xs text-muted-foreground">{data.contactEmailMasked ?? "—"}</p>
          {data.contactPhoneMasked && (
            <p className="text-xs text-muted-foreground">{data.contactPhoneMasked}</p>
          )}
        </div>
        <button
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
          onClick={onClose}
          aria-label="Close detail panel"
        >
          ✕
        </button>
      </div>

      <Separator />

      {/* Checkout + Order fields */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <DetailField label="Order #" value={data.orderNumber} />
        <DetailField label="Order status" value={data.orderStatus} />
        <DetailField label="Package" value={data.orderPackageCode ?? data.checkoutPackageCode} />
        <DetailField label="Total" value={fmtCurrency(data.orderTotalCents ?? data.checkoutTotalCents)} />
        {data.orderRefundedCents != null && data.orderRefundedCents > 0 && (
          <DetailField label="Refunded" value={fmtCurrency(data.orderRefundedCents)} />
        )}
        <DetailField label="Checkout status" value={data.checkoutStatus} />
        <DetailField label="Payment state" value={data.checkoutPaymentState} />
        <DetailField label="Created" value={fmtDate(data.checkoutCreatedAt ?? data.orderCreatedAt)} />
        {data.checkoutCompletedAt && (
          <DetailField label="Completed" value={fmtDate(data.checkoutCompletedAt)} />
        )}
      </dl>

      {/* Application + Appointment */}
      {(data.applicationStatus || data.appointmentStatus) && (
        <>
          <Separator />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            {data.applicationStatus && (
              <>
                <DetailField label="Application" value={data.applicationStatus} />
                <DetailField label="Submitted" value={fmtDate(data.applicationSubmittedAt)} />
              </>
            )}
            {data.appointmentStatus && (
              <>
                <DetailField label="Appointment" value={data.appointmentStatus} />
                <DetailField label="Scheduled" value={fmtDate(data.appointmentScheduledAt)} />
              </>
            )}
          </dl>
        </>
      )}

      {/* Provider correlations */}
      {data.providerCorrelations.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Provider Correlations
            </p>
            <ul className="space-y-1 text-xs">
              {data.providerCorrelations.map((c) => (
                <li key={c.id} className="flex items-start gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">{c.provider}</Badge>
                  <span className="text-muted-foreground">{c.providerEntityType}</span>
                  <code className="font-mono text-xs break-all text-muted-foreground">{c.providerEntityId}</code>
                  <span className="text-muted-foreground">↔ {c.localEntityType}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* Attribution deliveries */}
      {data.attributionDeliveries.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Attribution Deliveries
            </p>
            <ul className="space-y-1 text-xs">
              {data.attributionDeliveries.map((ad) => (
                <li key={ad.id} className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-xs">{ad.provider}</Badge>
                  <StatusBadge status={ad.status} />
                  <span className="text-muted-foreground">{ad.attempts} attempts</span>
                  {ad.errorClass && (
                    <span className="text-amber-600 dark:text-amber-400">{ad.errorClass}</span>
                  )}
                   <code className="font-mono break-all text-muted-foreground">
                     event {ad.eventId}
                   </code>
                   {ad.externalReceiptId && (
                     <code className="font-mono break-all text-muted-foreground">
                       receipt {ad.externalReceiptId}
                     </code>
                   )}
                   {ad.externalIdempotencyKey && (
                     <code className="font-mono break-all text-muted-foreground">
                       delivery key {ad.externalIdempotencyKey}
                     </code>
                   )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* Lifecycle timeline */}
      {data.lifecycleEvents.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Lifecycle Timeline
            </p>
            <ol className="space-y-2 text-xs">
              {data.lifecycleEvents.map((le) => (
                <li key={le.id} className="flex items-start gap-2">
                  <div className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
                  <div>
                    <span className="font-medium">{capitalize(le.eventType)}</span>
                    {le.fromStatus && (
                      <span className="text-muted-foreground ml-1">
                        {le.fromStatus} → {le.toStatus ?? "?"}
                      </span>
                    )}
                    <span className="ml-2 text-muted-foreground">{fmtDate(le.createdAt)}</span>
                    {le.reason && <p className="text-muted-foreground mt-0.5">{le.reason}</p>}
                     {le.actorUserId && (
                       <p className="text-muted-foreground">
                         Actor <code className="font-mono">{le.actorUserId}</code>
                       </p>
                     )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}

      {/* Authority boundary notice */}
      <Separator />
      <div className="flex items-start gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/30 dark:text-slate-400">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          <strong>Authority boundary:</strong> Payment state cannot be modified here. No entitlements
          are granted from this console. SMS consent and GHL sales records are not exposed.
          Delivery actions (resend, reissue, revoke) operate on existing entitlement records only.
        </span>
      </div>

      {/* Payment event actions — derived from eligible rows */}
      <PaymentEventsSection
        events={data.paymentEvents}
        isPending={isPending}
        onRetry={(id) =>
          queueAction(
            "retry-payment",
            "Retry Payment Event",
            `Re-queue unprocessed payment event ${id}. This retries the downstream handler; it does not issue a new charge.`,
            id,
          )
        }
      />

      {/* Outbox actions — derived from eligible rows */}
      <OutboxSection
        entries={data.outboxEntries}
        isPending={isPending}
        onReplay={(id) =>
          queueAction(
            "replay-outbox",
            "Replay GHL Outbox Entry",
            `Reset outbox entry ${id} from failed/dead_letter to pending. The GHL sync job will re-dispatch it.`,
            id,
          )
        }
      />

      {/* Entitlement actions — delivery actions on active entitlements only */}
      <EntitlementsSection
        entitlements={data.entitlements}
        isPending={isPending}
        onResend={(id) =>
          queueAction(
            "resend-delivery",
            "Resend Delivery",
            `Resend the delivery email/link for entitlement ${id}. Does not create a new entitlement record.`,
            id,
          )
        }
        onReissue={(id) =>
          queueAction(
            "reissue-delivery",
            "Reissue Delivery",
            `Reissue delivery credentials for entitlement ${id}. A new delivery credential is created; the original is superseded.`,
            id,
          )
        }
        onRevoke={(id) => setRevokeTargetId(id)}
      />
    </div>
  );
}
