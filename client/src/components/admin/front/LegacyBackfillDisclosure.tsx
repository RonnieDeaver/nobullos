import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ChevronDown, ChevronRight, AlertTriangle, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";

export function LegacyBackfillDisclosure({ onAfter }: { onAfter: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  // The full-backfill route is requireTeamLead server-side; don't show
  // account managers a control that always ends in a 403.
  const canRun = user?.role === "ceo" || user?.role === "team_lead";
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmInternal, setConfirmInternal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!canRun) return null;

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/integrations/front/full-backfill", { confirmInternal: true });
      await res.json().catch(() => ({}));
      toast({
        title: "Legacy full-backfill submitted",
        description: "This is a deprecated path. Prefer Historical Recovery.",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/messages"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/integrations/front/console/overview"] }); // fire-and-forget: cache refresh only
      onAfter();
    } catch (err: any) {
      toast({
        title: "Legacy full-backfill failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border border-red-200 bg-red-50/40 rounded p-3" data-testid="section-legacy-backfill">
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm font-medium text-red-700 cursor-pointer"
        onClick={() => setOpen((v) => !v)}
        data-testid="button-toggle-legacy-backfill"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Advanced / Deprecated
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <p className="text-red-800">
            Legacy full-backfill walks every Front conversation page-by-page without window slicing.
            Use Historical Recovery instead — it is resumable, observable, and supports custom windows.
          </p>
          <div className="flex items-center gap-2">
            <Checkbox
              id="confirm-internal-legacy"
              checked={confirmInternal}
              onCheckedChange={(v) => setConfirmInternal(v === true)}
              data-testid="checkbox-legacy-confirm-internal"
            />
            <Label htmlFor="confirm-internal-legacy" className="text-xs cursor-pointer">
              I understand this is a deprecated path (confirmInternal).
            </Label>
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={submit}
            disabled={!confirmInternal || submitting}
            data-testid="button-run-legacy-backfill"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />}
            Run legacy full-backfill
          </Button>
        </div>
      )}
    </div>
  );
}
