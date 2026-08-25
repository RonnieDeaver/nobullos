import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { FilterRule, FilterRuleScope, FilterRuleType } from "./types";
import { normalizeRuleValueClient } from "./utils";

export function FilterRuleEditorDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: FilterRule | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [type, setType] = useState<FilterRuleType>(initial?.type ?? "dismiss");
  const [scope, setScope] = useState<FilterRuleScope>(initial?.scope ?? "sender_email");
  const [value, setValue] = useState<string>(initial?.value ?? "");
  const [notes, setNotes] = useState<string>(initial?.notes ?? "");
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  const [applyRetroactively, setApplyRetroactively] = useState<boolean>(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewResult, setPreviewResult] = useState<{ totalSelected: number; eligibleCount: number } | null>(null);

  useEffect(() => {
    if (open) {
      setType(initial?.type ?? "dismiss");
      setScope(initial?.scope ?? "sender_email");
      setValue(initial?.value ?? "");
      setNotes(initial?.notes ?? "");
      setEnabled(initial?.enabled ?? true);
      setApplyRetroactively(false);
      setPreviewResult(null);
    }
  }, [open, initial]);

  useEffect(() => {
    setPreviewResult(null);
  }, [type, scope, value]);

  const normalizedValue = useMemo(() => normalizeRuleValueClient(scope, value), [scope, value]);
  const canSubmit = normalizedValue.length > 0 && !saving;

  const handlePreview = async () => {
    if (!normalizedValue) {
      toast({ title: "Value required", description: "Enter a value to preview.", variant: "destructive" });
      return;
    }
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/filter-rules/preview", {
        type, scope, value: normalizedValue,
      });
      const data = await res.json();
      setPreviewResult({ totalSelected: data.totalSelected ?? 0, eligibleCount: data.eligibleCount ?? 0 });
      toast({
        title: "Preview ready",
        description: `${data.eligibleCount ?? 0} message(s) would be affected (${data.totalSelected ?? 0} matched the selection).`,
      });
    } catch (err: any) {
      toast({ title: "Preview failed", description: err?.message || "Try again.", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  const [confirmSaveApply, setConfirmSaveApply] = useState(false);

  const performSave = async (alsoApply: boolean) => {
    if (!normalizedValue) return;
    setSaving(true);
    try {
      const body = { type, scope, value: normalizedValue, notes: notes || null, enabled };
      let savedId: string;
      if (initial) {
        const res = await apiRequest("PATCH", `/api/integrations/front/filter-rules/${initial.id}`, body);
        const data = await res.json();
        savedId = data.rule.id;
      } else {
        const res = await apiRequest("POST", "/api/integrations/front/filter-rules", body);
        const data = await res.json();
        savedId = data.rule.id;
      }

      if (alsoApply) {
        try {
          const res = await apiRequest("POST", `/api/integrations/front/filter-rules/${savedId}/apply`, {});
          const json = await res.json();
          toast({ title: "Apply enqueued", description: `~${json.estimatedCount ?? 0} item(s) queued (job ${json.jobId}).` });
        } catch (err: any) {
          toast({ title: "Apply failed", description: err?.message || "Could not enqueue apply job.", variant: "destructive" });
        }
      }

      toast({ title: initial ? "Filter rule updated" : "Filter rule created" });
      onSaved();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message || "Try again.", variant: "destructive" });
    } finally {
      setSaving(false);
      setConfirmSaveApply(false);
    }
  };

  const handleSave = async () => {
    if (!normalizedValue) return;
    if (applyRetroactively) {
      if (!previewResult) {
        toast({
          title: "Preview required",
          description: "Run Preview first to see how many messages will be affected before applying retroactively.",
          variant: "destructive",
        });
        return;
      }
      setConfirmSaveApply(true);
      return;
    }
    await performSave(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-filter-rule-editor" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit filter rule" : "New filter rule"}</DialogTitle>
          <DialogDescription>
            Rules are evaluated at ingestion time. Precedence: <strong>block</strong> &gt; <strong>dismiss</strong> &gt; <strong>never_match</strong>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as FilterRuleType)}>
                <SelectTrigger data-testid="select-rule-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="block">Block</SelectItem>
                  <SelectItem value="dismiss">Dismiss</SelectItem>
                  <SelectItem value="never_match">Never match</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as FilterRuleScope)}>
                <SelectTrigger data-testid="select-rule-scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sender_email">Sender email</SelectItem>
                  <SelectItem value="domain">Domain</SelectItem>
                  <SelectItem value="channel">Channel (inbox)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label>Value</Label>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                scope === "sender_email" ? "spammer@example.com" :
                scope === "domain" ? "example.com" :
                "support@firm.com"
              }
              data-testid="input-rule-value"
            />
            {value && normalizedValue !== value.trim() && (
              <p className="text-xs text-gray-500">Will be saved as: <code>{normalizedValue}</code></p>
            )}
          </div>
          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Why this rule exists, who requested it, etc."
              rows={2}
              data-testid="input-rule-notes"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="checkbox-apply-retroactively"
              checked={applyRetroactively}
              onCheckedChange={(v) => setApplyRetroactively(v === true)}
              data-testid="checkbox-apply-retroactively"
            />
            <Label htmlFor="checkbox-apply-retroactively" className="cursor-pointer text-sm">
              Apply retroactively after save (background job)
            </Label>
          </div>
          {previewResult && (
            <div className="text-xs bg-blue-50 border border-blue-200 rounded p-2" data-testid="text-rule-preview-result">
              Would affect <strong>{previewResult.eligibleCount}</strong> eligible message(s) ({previewResult.totalSelected} matched the selection).
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={handlePreview}
            disabled={previewing || !normalizedValue}
            data-testid="button-preview-rule"
          >
            {previewing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Preview
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSubmit || (applyRetroactively && !previewResult)}
            data-testid="button-save-rule"
            title={applyRetroactively && !previewResult ? "Run Preview before saving with retroactive apply" : undefined}
          >
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            {initial
              ? (applyRetroactively ? "Save & apply…" : "Save changes")
              : (applyRetroactively ? "Create & apply…" : "Create rule")}
          </Button>
        </DialogFooter>

        <Dialog open={confirmSaveApply} onOpenChange={(o) => { if (!o) setConfirmSaveApply(false); }}>
          <DialogContent data-testid="dialog-save-apply-confirm" className="max-w-md">
            <DialogHeader>
              <DialogTitle>Save and apply retroactively?</DialogTitle>
              <DialogDescription>
                This will save the rule and immediately enqueue a background job that
                applies it to existing messages.
              </DialogDescription>
            </DialogHeader>
            <div className="text-sm bg-blue-50 border border-blue-200 rounded p-3" data-testid="text-save-apply-preview-count">
              <strong>{previewResult?.eligibleCount ?? 0}</strong> message(s) will be affected
              {" "}<span className="text-gray-600">({previewResult?.totalSelected ?? 0} matched the selection).</span>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setConfirmSaveApply(false)}
                disabled={saving}
                data-testid="button-cancel-save-apply"
              >
                Cancel
              </Button>
              <Button
                onClick={() => performSave(true)}
                disabled={saving}
                data-testid="button-confirm-save-apply"
              >
                {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                Save & apply to {previewResult?.eligibleCount ?? 0} message{(previewResult?.eligibleCount ?? 0) === 1 ? "" : "s"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}
