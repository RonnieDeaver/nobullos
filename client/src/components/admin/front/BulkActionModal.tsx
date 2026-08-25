import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { BULK_ACTION_LABELS, type BulkAction, type BulkPreview, type BulkSelection } from "./types";

// Module-level so `canSubmit`'s useMemo doesn't depend on a Set recreated
// every render.
const TARGET_VALIDATION_KEYS = new Set([
  "missing_target_client_id",
  "missing_dismiss_reason",
  "missing_sender_email",
  "missing_domain",
]);

export function BulkActionModal({
  open,
  onOpenChange,
  action,
  selection,
  selectionLabel,
  clientOptions,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  action: BulkAction;
  selection: BulkSelection;
  selectionLabel: string;
  clientOptions: Array<{ value: string; label: string }>;
  onCompleted: () => void;
}) {
  const { toast } = useToast();
  const [target, setTarget] = useState<{ clientId?: string; reason?: string; senderEmail?: string; domain?: string }>({});
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setTarget({});
      setPreview(null);
      setPreviewError(null);
    }
  }, [open, action]);

  const runPreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/bulk-action/preview", {
        action,
        target,
        selection,
      });
      const body: BulkPreview = await res.json();
      setPreview(body);
      if (action === "block_sender" && body.uniqueSender && !target.senderEmail) {
        setTarget((t) => ({ ...t, senderEmail: body.uniqueSender ?? undefined }));
      }
      if (action === "block_domain" && body.uniqueDomain && !target.domain) {
        setTarget((t) => ({ ...t, domain: body.uniqueDomain ?? undefined }));
      }
    } catch (err: any) {
      setPreviewError(err?.message ?? "Preview failed");
    } finally {
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => { void runPreview(); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.clientId, target.reason, target.senderEmail, target.domain]);

  const canSubmit = useMemo(() => {
    if (!preview) return false;
    if (preview.eligibleCount === 0) return false;
    const blockingErrors = preview.errors.filter(e => !TARGET_VALIDATION_KEYS.has(e));
    if (blockingErrors.length > 0) return false;
    if (action === "assign" && !target.clientId) return false;
    if (action === "dismiss" && !(target.reason || "").trim()) return false;
    if (action === "block_sender" && !(target.senderEmail || preview.uniqueSender)) return false;
    if (action === "block_domain" && !(target.domain || preview.uniqueDomain)) return false;
    return true;
  }, [preview, target, action]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/bulk-action", {
        action,
        target,
        selection,
      });
      const body: any = await res.json();
      if (body.jobId) {
        toast({
          title: "Bulk job queued",
          description: `${BULK_ACTION_LABELS[action]} — ${body.estimatedCount} items queued. Track progress in Overview & Jobs.`,
        });
      } else {
        const variant = body.failed > 0 ? "destructive" : undefined;
        toast({
          title: body.failed > 0 ? "Bulk action partially completed" : "Bulk action complete",
          description: `${body.succeeded ?? 0} succeeded, ${body.failed ?? 0} failed of ${body.totalProcessed ?? 0}.`,
          variant,
        });
      }
      onCompleted();
      onOpenChange(false);
    } catch (err: any) {
      toast({
        title: "Bulk action failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-[calc(100vw-2rem)]" data-testid="dialog-front-bulk-action">
        <DialogHeader>
          <DialogTitle>{BULK_ACTION_LABELS[action]}</DialogTitle>
          <DialogDescription>{selectionLabel}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {action === "assign" && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-assign-client">Target client</Label>
              <Select value={target.clientId ?? ""} onValueChange={(v) => setTarget((t) => ({ ...t, clientId: v }))}>
                <SelectTrigger id="bulk-assign-client" data-testid="select-bulk-assign-client">
                  <SelectValue placeholder="Select client…" />
                </SelectTrigger>
                <SelectContent>
                  {clientOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value} data-testid={`option-bulk-client-${o.value}`}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">Each message will be linked to this client and stamped <span className="font-mono">manual_bulk</span>.</p>
            </div>
          )}

          {action === "dismiss" && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-dismiss-reason">Dismiss reason</Label>
              <Textarea
                id="bulk-dismiss-reason"
                value={target.reason ?? ""}
                onChange={(e) => setTarget((t) => ({ ...t, reason: e.target.value }))}
                placeholder="Why should these messages be dismissed?"
                rows={3}
                data-testid="textarea-bulk-dismiss-reason"
              />
            </div>
          )}

          {action === "block_sender" && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-block-sender">Sender email to block</Label>
              <Input
                id="bulk-block-sender"
                value={target.senderEmail ?? ""}
                onChange={(e) => setTarget((t) => ({ ...t, senderEmail: e.target.value }))}
                placeholder="sender@example.com"
                data-testid="input-bulk-block-sender"
              />
              {preview?.distinctSenders != null && preview.distinctSenders > 1 && (
                <p className="text-xs text-amber-700">
                  Selection contains {preview.distinctSenders} distinct senders — only the email entered above will be blocked.
                </p>
              )}
            </div>
          )}

          {action === "block_domain" && (
            <div className="space-y-1.5">
              <Label htmlFor="bulk-block-domain">Domain to block</Label>
              <Input
                id="bulk-block-domain"
                value={target.domain ?? ""}
                onChange={(e) => setTarget((t) => ({ ...t, domain: e.target.value }))}
                placeholder="example.com"
                data-testid="input-bulk-block-domain"
              />
              {preview?.distinctDomains != null && preview.distinctDomains > 1 && (
                <p className="text-xs text-amber-700">
                  Selection contains {preview.distinctDomains} distinct domains — only the domain entered above will be blocked.
                </p>
              )}
            </div>
          )}

          {action === "not_a_match" && (
            <p className="text-sm text-gray-600 bg-gray-50 border rounded p-2">
              Removes the current client link and stamps <span className="font-mono">match_method=manual_bulk</span>.
              The system will treat the row as unmatched in subsequent rematch passes.
            </p>
          )}

          <div className="border rounded p-3 bg-gray-50/50 space-y-2 text-sm" data-testid="panel-bulk-preview">
            <div className="flex items-center justify-between">
              <span className="font-medium text-gray-700">Selection summary</span>
              <Button
                size="sm"
                variant="outline"
                onClick={runPreview}
                disabled={previewLoading}
                data-testid="button-bulk-refresh-preview"
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${previewLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
            {previewLoading && <p className="text-xs text-gray-500">Counting affected messages…</p>}
            {previewError && (
              <p className="text-xs text-red-700" data-testid="text-bulk-preview-error">{previewError}</p>
            )}
            {preview && (
              <div className="space-y-1.5 text-xs">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span data-testid="text-bulk-preview-total">Total: <span className="font-semibold">{preview.totalSelected}</span></span>
                  <span data-testid="text-bulk-preview-eligible">Eligible: <span className="font-semibold text-emerald-700">{preview.eligibleCount}</span></span>
                  {preview.ineligibleCount > 0 && (
                    <span data-testid="text-bulk-preview-ineligible">Skipped: <span className="font-semibold text-amber-700">{preview.ineligibleCount}</span></span>
                  )}
                  <span>Senders: {preview.distinctSenders}</span>
                  <span>Domains: {preview.distinctDomains}</span>
                </div>
                {preview.willRunAsBackgroundJob && (
                  <p className="text-amber-700">
                    <AlertTriangle className="w-3 h-3 inline mr-0.5 -mt-0.5" />
                    Above sync cap of {preview.cap} — will run as a background job. Progress will appear in Overview &amp; Jobs.
                  </p>
                )}
                {Object.keys(preview.ineligibleReasons).length > 0 && (
                  <p className="text-gray-600">
                    Skip reasons: {Object.entries(preview.ineligibleReasons).map(([k, v]) => `${k} (${v})`).join(", ")}
                  </p>
                )}
                {preview.errors.length > 0 && (
                  <p className="text-red-700" data-testid="text-bulk-preview-validation-errors">
                    {preview.errors.join(" · ")}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid="button-bulk-cancel">
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || submitting}
            data-testid="button-front-confirm-bulk"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5 mr-1.5" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
