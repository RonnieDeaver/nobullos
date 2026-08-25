import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Play, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { CanonicalAction } from "./types";

export function CanonicalActionModal({
  open,
  onOpenChange,
  action,
  onAfter,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  action: CanonicalAction;
  onAfter: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const supportsDryRun = true;
  const [dryRun, setDryRun] = useState(supportsDryRun);
  const [submitting, setSubmitting] = useState(false);
  const [cohort, setCohort] = useState<string>("");
  const [maxItems, setMaxItems] = useState<string>("500");

  useEffect(() => {
    if (open) {
      setDryRun(supportsDryRun);
      setCohort("");
      setMaxItems("500");
    }
  }, [open, action, supportsDryRun]);

  const titles: Record<CanonicalAction, string> = {
    rematch_all: "Rematch All",
    reprocess_dismissed: "Reprocess Dismissed",
  };
  const descriptions: Record<CanonicalAction, string> = {
    rematch_all: "Re-run the matching engine across every Front sync record. Existing matches are preserved unless evidence changes.",
    reprocess_dismissed: "Re-evaluate dismissed-as-operational messages against the current rules and AI signals.",
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      let res: Response;
      if (action === "rematch_all") {
        res = await apiRequest("POST", "/api/integrations/front/rematch-all", { dryRun });
      } else {
        const body: any = { dryRun, resume: true };
        if (cohort.trim()) body.cohort = cohort.trim();
        const n = parseInt(maxItems, 10);
        if (!Number.isNaN(n) && n > 0) body.maxItems = n;
        res = await apiRequest("POST", "/api/integrations/front/reprocess-dismissed", body);
      }
      await res.json().catch(() => ({}));
      toast({
        title: supportsDryRun && dryRun ? `${titles[action]} (dry-run) submitted` : `${titles[action]} submitted`,
        description: "Track progress in Current & recent jobs below.",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/messages"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/filter-rules"] }); // fire-and-forget: cache refresh only
      onAfter();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: `${titles[action]} failed`, description: err?.message ?? "Unknown error", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]" data-testid={`dialog-canonical-${action}`}>
        <DialogHeader>
          <DialogTitle>{titles[action]}</DialogTitle>
          <DialogDescription>{descriptions[action]}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {action === "reprocess_dismissed" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="rd-cohort" className="text-xs">Cohort (optional)</Label>
                <Input
                  id="rd-cohort"
                  value={cohort}
                  onChange={(e) => setCohort(e.target.value)}
                  placeholder="e.g. 2025-Q4-spam-rule"
                  data-testid="input-reprocess-cohort"
                />
              </div>
              <div>
                <Label htmlFor="rd-max" className="text-xs">Max items</Label>
                <Input
                  id="rd-max"
                  type="number"
                  value={maxItems}
                  onChange={(e) => setMaxItems(e.target.value)}
                  data-testid="input-reprocess-max-items"
                />
              </div>
            </div>
          )}
          {supportsDryRun ? (
            <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded p-2">
              <Checkbox
                id={`dry-run-${action}`}
                checked={dryRun}
                onCheckedChange={(v) => setDryRun(v === true)}
                data-testid={`checkbox-canonical-dry-run-${action}`}
              />
              <Label htmlFor={`dry-run-${action}`} className="text-xs cursor-pointer">
                Dry run — calculate what would change but make no writes.
              </Label>
            </div>
          ) : (
            <div
              className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2"
              data-testid={`note-canonical-no-dry-run-${action}`}
            >
              Dry-run is not supported for this action — running it will write
              classification results.
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting} data-testid={`button-canonical-cancel-${action}`}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting} data-testid={`button-canonical-confirm-${action}`}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Play className="w-3.5 h-3.5 mr-1.5" />}
            {supportsDryRun && dryRun ? "Run dry-run" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
