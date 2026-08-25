import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  X, CheckCircle, User, ExternalLink, ChevronDown, ChevronRight,
  UserPlus, Ban, ShieldOff, MailX, Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { matchMethodLabel, matchMethodColor, reviewReasonLabel } from "@/lib/matchMethod";
import { frontPercentDisplay } from "@shared/frontConsoleMetrics";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import type { FrontMessageFeed, RowActionKind } from "./types";

export function MessageRow({
  msg,
  isExpanded,
  onToggle,
  selected,
  onToggleSelected,
  clientOptions,
}: {
  msg: FrontMessageFeed;
  isExpanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onToggleSelected: (next: boolean) => void;
  clientOptions: Array<{ value: string; label: string }>;
}) {
  const senderName = msg.senderName || msg.senderEmail || msg.participants?.[0]?.name || msg.participants?.[0]?.email || "Unknown";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const eligible = new Set(msg.eligibleActions ?? []);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignClientId, setAssignClientId] = useState<string>("");
  const [confirmAction, setConfirmAction] = useState<RowActionKind | null>(null);
  const [dismissReason, setDismissReason] = useState<string>("");

  type FrontClientSuggestion = { clientId: string; firmName: string; score: number; reasons: string[] };
  const suggestionEmail = msg.senderEmail || "";
  const { data: suggestions = [] } = useQuery<FrontClientSuggestion[]>({
    queryKey: ["/api/integrations/front/client-suggestions", suggestionEmail],
    queryFn: async () => {
      const res = await fetch(
        `/api/integrations/front/client-suggestions?email=${encodeURIComponent(suggestionEmail)}&limit=5`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: assignOpen && suggestionEmail.includes("@"),
    staleTime: 60_000,
  });

  const invalidateAfterAction = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/messages"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/filter-rules"] }); // fire-and-forget: cache refresh only
  };

  const priorClientIdRef = useRef<string | null>(null);

  const pendingUndoRef = useRef<
    | {
        dismiss: () => void;
        expectedStatus: FrontMessageFeed["effectiveMatchStatus"];
        expectedClientId: string | null;
      }
    | null
  >(null);

  const clearPendingUndo = () => {
    if (pendingUndoRef.current) {
      pendingUndoRef.current.dismiss();
      pendingUndoRef.current = null;
    }
  };

  useEffect(() => {
    const pending = pendingUndoRef.current;
    if (!pending) return;
    const statusDrifted = msg.effectiveMatchStatus !== pending.expectedStatus;
    const clientDrifted = (msg.clientId ?? null) !== pending.expectedClientId;
    if (statusDrifted || clientDrifted) {
      clearPendingUndo();
    }
  }, [msg.effectiveMatchStatus, msg.clientId]);

  useEffect(() => {
    return () => {
      clearPendingUndo();
    };
  }, []);

  const callRowAction = async ({ kind, clientId, reason }: { kind: RowActionKind; clientId?: string; reason?: string }) => {
    const path = kind === "promote" ? "promote" : kind;
    let body: Record<string, unknown> | undefined;
    if (kind === "assign") body = { clientId };
    else if (kind === "dismiss" && reason && reason.trim().length > 0) body = { reason: reason.trim() };
    const res = await apiRequest("POST", `/api/integrations/unmatched/front/${msg.id}/${path}`, body);
    return res.json();
  };

  const undoMutation = useMutation({
    meta: { silent: true },
    mutationFn: callRowAction,
    onSuccess: () => {
      toast({ title: "Action reverted" });
      invalidateAfterAction();
    },
    onError: (err: any) => {
      toast({
        title: "Undo failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const inverseFor = (
    kind: RowActionKind,
    priorClientId: string | null,
  ): { kind: RowActionKind; clientId?: string } | null => {
    if (kind === "dismiss" || kind === "block") return { kind: "promote" };
    if (kind === "promote" && priorClientId) return { kind: "assign", clientId: priorClientId };
    return null;
  };

  const rowActionMutation = useMutation({
    meta: { silent: true },
    mutationFn: ({ kind, clientId, reason }: { kind: RowActionKind; clientId?: string; reason?: string }) => {
      priorClientIdRef.current = msg.clientId ?? null;
      return callRowAction({ kind, clientId, reason });
    },
    onSuccess: (_data, vars) => {
      const labels: Record<RowActionKind, string> = {
        assign: "Assigned to client",
        dismiss: "Dismissed",
        block: "Blocked",
        promote: "Marked as not a match",
      };
      const inverse = inverseFor(vars.kind, priorClientIdRef.current);

      clearPendingUndo();

      const { dismiss: dismissToast } = toast({
        title: labels[vars.kind],
        action: inverse ? (
          <ToastAction
            altText="Undo"
            data-testid={`button-row-undo-${msg.id}`}
            onClick={() => {
              clearPendingUndo();
              undoMutation.mutate(inverse);
            }}
          >
            Undo
          </ToastAction>
        ) : undefined,
      });

      if (inverse) {
        const expectedStatus: FrontMessageFeed["effectiveMatchStatus"] =
          vars.kind === "dismiss"
            ? "dismissed_operational"
            : vars.kind === "block"
            ? "blocked"
            : "unmatched";
        const expectedClientId = vars.kind === "promote" ? null : msg.clientId ?? null;
        pendingUndoRef.current = { dismiss: dismissToast, expectedStatus, expectedClientId };
        setTimeout(() => {
          if (pendingUndoRef.current?.dismiss === dismissToast) {
            clearPendingUndo();
          }
        }, 8000);
      }

      invalidateAfterAction();
      setAssignOpen(false);
      setAssignClientId("");
      setConfirmAction(null);
      setDismissReason("");
    },
    onError: (err: any) => {
      toast({
        title: "Action failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const confirmCopy: Record<RowActionKind, { title: string; description: string; confirmLabel: string; destructive?: boolean }> = {
    assign: { title: "Assign", description: "", confirmLabel: "Assign" },
    dismiss: {
      title: "Dismiss this message?",
      description: "Marks the message as operational/non-billable. The system will learn from this dismissal.",
      confirmLabel: "Dismiss",
    },
    block: {
      title: "Block this message?",
      description: "Future messages from this sender pattern will be auto-filtered. Existing rows are not changed.",
      confirmLabel: "Block",
      destructive: true,
    },
    promote: {
      title: "Mark as not a match?",
      description: "Removes the current client link and resets the message to unmatched for re-evaluation.",
      confirmLabel: "Mark not a match",
    },
  };

  const hasAnyAction =
    eligible.has("assign") || eligible.has("dismiss") || eligible.has("block") || eligible.has("markNotAMatch");

  return (
    <div
      className={`border rounded-lg overflow-hidden ${selected ? "ring-2 ring-blue-300 border-blue-300" : ""}`}
      data-testid={`row-front-message-${msg.id}`}
    >
      <div
        className="flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors"
      >
        <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onToggleSelected(v === true)}
            data-testid={`checkbox-front-select-${msg.id}`}
            aria-label={`Select message ${msg.id}`}
          />
        </div>
        <button
          type="button"
          className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer text-left"
          onClick={onToggle}
          data-testid={`button-expand-${msg.id}`}
        >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate" data-testid={`text-preview-${msg.id}`}>
            {msg.title || msg.contentPreview || "(no subject)"}
          </p>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span>{senderName}</span>
            <span>·</span>
            <span>{format(new Date(msg.timestamp), "MMM d, h:mm a")}</span>
          </div>
        </div>
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          {msg.clientId ? (
            <>
              <Badge variant="outline" className={matchMethodColor(msg.matchMethod)} data-testid={`badge-method-${msg.id}`}>
                {matchMethodLabel(msg.matchMethod)}
              </Badge>
              <Badge
                variant="outline"
                className="bg-green-50 text-green-700 border-green-200"
                data-testid={`badge-match-${msg.id}`}
              >
                <User className="w-3 h-3 mr-1" />
                {msg.clientName}
                {msg.matchConfidence != null && (
                  <span className="ml-1 text-green-500 text-xs">
                    {frontPercentDisplay(msg.matchConfidence * 100, 0).text}
                  </span>
                )}
              </Badge>
            </>
          ) : msg.effectiveMatchStatus === "dismissed_operational" || msg.effectiveMatchStatus === "dismissed" ? (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200" data-testid={`badge-dismissed-${msg.id}`}>
              Dismissed
            </Badge>
          ) : msg.effectiveMatchStatus === "blocked" ? (
            <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200" data-testid={`badge-blocked-${msg.id}`}>
              Blocked
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border" data-testid={`badge-unmatched-${msg.id}`}>
              Unmatched
            </Badge>
          )}

          {hasAnyAction && (
            <div onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    disabled={rowActionMutation.isPending}
                    data-testid={`button-row-actions-${msg.id}`}
                    aria-label="Row actions"
                  >
                    {rowActionMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <MoreHorizontal className="w-4 h-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" data-testid={`menu-row-actions-${msg.id}`}>
                  {eligible.has("assign") && (
                    <DropdownMenuItem
                      onSelect={() => { setAssignClientId(""); setAssignOpen(true); }}
                      data-testid={`menu-action-assign-${msg.id}`}
                    >
                      <UserPlus className="w-3.5 h-3.5 mr-2" /> Assign to client
                    </DropdownMenuItem>
                  )}
                  {eligible.has("dismiss") && (
                    <DropdownMenuItem
                      onSelect={() => setConfirmAction("dismiss")}
                      data-testid={`menu-action-dismiss-${msg.id}`}
                    >
                      <MailX className="w-3.5 h-3.5 mr-2" /> Dismiss
                    </DropdownMenuItem>
                  )}
                  {eligible.has("block") && (
                    <DropdownMenuItem
                      onSelect={() => setConfirmAction("block")}
                      data-testid={`menu-action-block-${msg.id}`}
                    >
                      <Ban className="w-3.5 h-3.5 mr-2" /> Block
                    </DropdownMenuItem>
                  )}
                  {eligible.has("markNotAMatch") && (
                    <DropdownMenuItem
                      onSelect={() => setConfirmAction("promote")}
                      data-testid={`menu-action-not-a-match-${msg.id}`}
                    >
                      <ShieldOff className="w-3.5 h-3.5 mr-2" /> Mark as not a match
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>

      <Dialog open={assignOpen} onOpenChange={(v) => { if (!rowActionMutation.isPending) setAssignOpen(v); }}>
        <DialogContent className="max-w-sm w-[calc(100vw-2rem)]" data-testid={`dialog-row-assign-${msg.id}`}>
          <DialogHeader>
            <DialogTitle>Assign to client</DialogTitle>
            <DialogDescription>
              Link this Front message to a client. The match will be stamped as a manual assignment.
            </DialogDescription>
          </DialogHeader>
          {suggestions.length > 0 && (
            <div className="space-y-1.5" data-testid={`section-row-assign-suggestions-${msg.id}`}>
              <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Suggested
              </Label>
              <div className="border rounded-lg overflow-hidden">
                {suggestions.map((s) => {
                  const isActive = assignClientId === s.clientId;
                  return (
                    <button
                      key={`row-assign-suggested-${msg.id}-${s.clientId}`}
                      type="button"
                      onClick={() => setAssignClientId(s.clientId)}
                      disabled={rowActionMutation.isPending}
                      className={`w-full text-left p-2.5 flex items-start gap-2 border-b last:border-b-0 disabled:opacity-50 ${
                        isActive ? "bg-blue-50" : "hover:bg-muted/50"
                      }`}
                      data-testid={`button-row-assign-suggested-${msg.id}-${s.clientId}`}
                    >
                      <User className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">{s.firmName}</span>
                        <span
                          className="block text-xs text-muted-foreground truncate"
                          data-testid={`text-row-assign-suggested-reason-${msg.id}-${s.clientId}`}
                        >
                          {s.reasons.join(" · ")}
                        </span>
                      </span>
                      {isActive && (
                        <CheckCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-blue-600" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`row-assign-client-${msg.id}`}>
              {suggestions.length > 0 ? "Or pick another client" : "Target client"}
            </Label>
            <Select value={assignClientId} onValueChange={setAssignClientId}>
              <SelectTrigger id={`row-assign-client-${msg.id}`} data-testid={`select-row-assign-client-${msg.id}`}>
                <SelectValue placeholder="Select client…" />
              </SelectTrigger>
              <SelectContent>
                {clientOptions
                  .filter((o) => o.value && o.value !== "all")
                  .map((o) => (
                    <SelectItem
                      key={o.value}
                      value={o.value}
                      data-testid={`option-row-assign-client-${msg.id}-${o.value}`}
                    >
                      {o.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setAssignOpen(false)}
              disabled={rowActionMutation.isPending}
              data-testid={`button-row-assign-cancel-${msg.id}`}
            >
              Cancel
            </Button>
            <Button
              onClick={() => rowActionMutation.mutate({ kind: "assign", clientId: assignClientId })}
              disabled={!assignClientId || rowActionMutation.isPending}
              data-testid={`button-row-assign-confirm-${msg.id}`}
            >
              {rowActionMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
              )}
              Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null && confirmAction !== "assign"}
        onOpenChange={(v) => {
          if (!v && !rowActionMutation.isPending) {
            setConfirmAction(null);
            setDismissReason("");
          }
        }}
      >
        <AlertDialogContent data-testid={`dialog-row-confirm-${msg.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction ? confirmCopy[confirmAction].title : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction ? confirmCopy[confirmAction].description : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction === "dismiss" && (
            <div className="space-y-2">
              <Label htmlFor={`row-dismiss-reason-${msg.id}`} className="text-sm">
                Dismiss reason <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Textarea
                id={`row-dismiss-reason-${msg.id}`}
                rows={3}
                value={dismissReason}
                onChange={(e) => setDismissReason(e.target.value)}
                placeholder="Why is this being dismissed? Helps the classifier learn."
                disabled={rowActionMutation.isPending}
                data-testid={`textarea-row-dismiss-reason-${msg.id}`}
              />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={rowActionMutation.isPending}
              data-testid={`button-row-confirm-cancel-${msg.id}`}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmAction && confirmAction !== "assign") {
                  rowActionMutation.mutate({
                    kind: confirmAction,
                    ...(confirmAction === "dismiss" ? { reason: dismissReason } : {}),
                  });
                }
              }}
              className={confirmAction && confirmCopy[confirmAction].destructive
                ? "bg-red-600 hover:bg-red-700 focus:ring-red-600"
                : undefined}
              data-testid={`button-row-confirm-${msg.id}`}
            >
              {rowActionMutation.isPending && (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              )}
              {confirmAction ? confirmCopy[confirmAction].confirmLabel : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isExpanded && (
        <div className="border-t bg-muted/50 p-4 space-y-3" data-testid={`expanded-${msg.id}`}>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground font-medium mb-1">Sender</p>
              <p>{senderName}</p>
              {msg.senderEmail && msg.senderEmail !== senderName && (
                <p className="text-xs text-muted-foreground" data-testid={`text-sender-email-${msg.id}`}>{msg.senderEmail}</p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Timestamp</p>
              <p>{format(new Date(msg.timestamp), "MMM d, yyyy h:mm:ss a")}</p>
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Match Method</p>
              {msg.matchMethod ? (
                <Badge variant="outline" className={matchMethodColor(msg.matchMethod)}>
                  {matchMethodLabel(msg.matchMethod)}
                  {msg.matchConfidence != null && ` (${frontPercentDisplay(msg.matchConfidence * 100, 0).text})`}
                </Badge>
              ) : (
                <span className="text-muted-foreground">No match</span>
              )}
            </div>
            <div>
              <p className="text-muted-foreground font-medium mb-1">Direction</p>
              <p>{msg.direction || "—"}</p>
            </div>
            {msg.inboxes && msg.inboxes.length > 0 && (
              <div className="col-span-2">
                <p className="text-muted-foreground font-medium mb-1">Inbox</p>
                <p className="text-xs" data-testid={`text-inbox-${msg.id}`}>{msg.inboxes.join(", ")}</p>
              </div>
            )}
          </div>

          {msg.contentText && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">Email Body</p>
              <div className="bg-card border rounded p-3 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto">
                {msg.contentText}
              </div>
            </div>
          )}

          {msg.resolved && (() => {
            const r = msg.resolved;
            const palette =
              r.resolution === "approved"
                ? { border: "border-emerald-300", bg: "bg-emerald-50", icon: "text-emerald-700", title: "text-emerald-900", body: "text-emerald-800", muted: "text-emerald-600" }
                : r.resolution === "reassigned"
                ? { border: "border-blue-300", bg: "bg-blue-50", icon: "text-blue-700", title: "text-blue-900", body: "text-blue-800", muted: "text-blue-600" }
                : { border: "border-border", bg: "bg-muted/50", icon: "text-foreground", title: "text-foreground", body: "text-foreground", muted: "text-muted-foreground" };
            const Icon = r.resolution === "dismissed" ? X : CheckCircle;
            const headline =
              r.resolution === "approved" ? "Approved" : r.resolution === "reassigned" ? "Reassigned" : "Dismissed";
            const reviewedAtLabel = r.reviewedAt
              ? format(new Date(r.reviewedAt), "MMM d, yyyy 'at' h:mm a")
              : null;
            return (
              <div
                className={`border ${palette.border} ${palette.bg} rounded-lg p-3 space-y-2`}
                data-testid={`resolved-panel-${msg.id}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Icon className={`w-4 h-4 ${palette.icon}`} />
                  <p className={`text-sm font-medium ${palette.title}`} data-testid={`resolved-headline-${msg.id}`}>
                    Resolved by reviewer — {headline}
                  </p>
                  {r.reviewReason && (
                    <span className={`text-xs ${palette.muted}`}>· {reviewReasonLabel(r.reviewReason)}</span>
                  )}
                </div>
                <p className={`text-xs ${palette.body}`} data-testid={`resolved-meta-${msg.id}`}>
                  <span className="font-medium">{r.reviewerName || "Unknown reviewer"}</span>
                  {reviewedAtLabel && <span className={`ml-1 ${palette.muted}`}>· {reviewedAtLabel}</span>}
                </p>
                {r.resolution === "dismissed" && r.dismissReason && (
                  <p className={`text-xs ${palette.body}`} data-testid={`resolved-dismiss-reason-${msg.id}`}>
                    <span className="font-medium">Dismiss reason:</span> {r.dismissReason}
                  </p>
                )}
                <div className={`text-xs ${palette.body} space-y-0.5`}>
                  <p data-testid={`resolved-suggested-${msg.id}`}>
                    <span className="font-medium">Original suggestion:</span>{" "}
                    {r.suggestedClientName || <span className={palette.muted}>None</span>}
                  </p>
                  <p data-testid={`resolved-final-${msg.id}`}>
                    <span className="font-medium">Final attribution:</span>{" "}
                    {r.finalClientName ? (
                      r.finalClientName
                    ) : (
                      <span className={palette.muted}>Unattributed</span>
                    )}
                    {r.resolution === "reassigned" && r.finalClientName && r.suggestedClientName && (
                      <span className={`ml-1 ${palette.muted}`}>(corrected from {r.suggestedClientName})</span>
                    )}
                  </p>
                </div>
              </div>
            );
          })()}

          {msg.aiSummary && (
            <div>
              <p className="text-muted-foreground font-medium mb-1 text-sm">AI Summary</p>
              <p className="text-sm bg-card border rounded p-3">{msg.aiSummary}</p>
            </div>
          )}

          {msg.externalUrl && (
            <div className="flex items-center gap-2 pt-2">
              <a
                href={msg.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                data-testid={`link-front-${msg.id}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View in Front
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
