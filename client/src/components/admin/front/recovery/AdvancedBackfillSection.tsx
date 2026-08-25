// F11A — extracted verbatim from FrontHistoricalRecoveryPanel.tsx (source @ fe87fb8ca).
// Behavior contract: copy, test IDs, query/mutation keys and states are unchanged.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Download, Loader2 } from "lucide-react";
import type {
  FullBackfillJobStatusResponse,
  FullBackfillProgress,
  FullBackfillStartResponse,
  IntegrationStatus,
} from "./types";

type Props = {
  recoveryAdvancedOpen: boolean;
  status: IntegrationStatus | undefined;
};

export function AdvancedBackfillSection({ recoveryAdvancedOpen, status }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToast();


  // Legacy full-backfill state (kept for the Advanced section's emergency button).
  const [backfillPollingJobId, setBackfillPollingJobId] = useState<string | null>(null);

  const [backfillProgress, setBackfillProgress] =
    useState<FullBackfillProgress | null>(null);

  const backfillPollFailCount = useRef(0);

  useEffect(() => {
    if (!backfillPollingJobId) return;
    backfillPollFailCount.current = 0;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/integrations/front/full-backfill/status/${backfillPollingJobId}`, { credentials: "include" });
        if (!res.ok) {
          backfillPollFailCount.current++;
          if (backfillPollFailCount.current >= 3) {
            setBackfillPollingJobId(null);
            setBackfillProgress(null);
          }
          return;
        }
        backfillPollFailCount.current = 0;
        const job = (await res.json()) as FullBackfillJobStatusResponse;
        if (job.status === "running" && job.result) {
          setBackfillProgress(job.result);
        }
        if (job.status === "complete") {
          setBackfillPollingJobId(null);
          setBackfillProgress(null);
          const r = job.result;
          const errCount = Array.isArray(r?.errors) ? r.errors.length : 0;
          const baseDesc = `${r?.pages ?? 0} pages, ${r?.scanned ?? 0} scanned, ${r?.ingested ?? 0} ingested, ${r?.skipped ?? 0} already synced`;
          toast({
            title: errCount > 0 ? "Full backfill finished with errors" : "Full backfill complete",
            description: errCount > 0 ? `${baseDesc}. First error: ${r!.errors![0]}` : baseDesc,
            variant: errCount > 0 ? "destructive" : undefined,
          });
          void queryClient.invalidateQueries({ queryKey: ["/api/integrations/all-status"] }); // fire-and-forget: cache refresh only
        } else if (job.status === "failed") {
          setBackfillPollingJobId(null);
          setBackfillProgress(null);
          const r = job.result;
          const detail = job.error || (Array.isArray(r?.errors) && r!.errors![0]) || "Unknown error";
          toast({ title: "Backfill failed", description: detail, variant: "destructive" });
        }
      } catch {
        backfillPollFailCount.current++;
        if (backfillPollFailCount.current >= 3) {
          setBackfillPollingJobId(null);
          setBackfillProgress(null);
        }
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [backfillPollingJobId, toast, queryClient]);


  const fullBackfillMutation = useMutation<FullBackfillStartResponse, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/front/full-backfill", { confirmInternal: true });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.jobId) {
        setBackfillPollingJobId(data.jobId);
        setBackfillProgress(null);
        toast({
          title: "Full backfill started",
          description: "Syncing all historical emails from Front. This may take a while.",
        });
      }
    },
    onError: (err) => {
      const msg = err.message?.includes("409") || err.message?.includes("already running")
        ? "A backfill is already running. Please wait for it to finish."
        : err.message;
      toast({ title: "Backfill failed", description: msg, variant: "destructive" });
    },
    meta: { silent: true },
  });

  return (
    <>
        {recoveryAdvancedOpen && (
          <div className="border-t pt-3 space-y-2" data-testid="section-recovery-advanced">
            <div className="text-xs text-amber-700 font-medium" data-testid="text-recovery-legacy-deprecation">
              Deprecated — use <span className="font-semibold">Recover gaps</span> above. Legacy "Full Backfill" sweeps the entire history with a single global cursor and is kept for emergency use only.
            </div>
            <div className="flex flex-wrap gap-2">
              <ConfirmActionDialog
                trigger={
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-gray-600"
                    data-testid="button-front-full-backfill"
                    disabled={!!backfillPollingJobId || fullBackfillMutation.isPending}
                  >
                    {backfillPollingJobId ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                    Legacy Full Backfill (internal)
                  </Button>
                }
                title="Run legacy full backfill?"
                description="Legacy: this sweeps the entire Front history with one global cursor. Prefer 'Recover gaps' above, which is checkpointed and gap-targeted."
                confirmLabel="Continue anyway"
                onConfirm={() => fullBackfillMutation.mutate()}
                testId="dialog-front-full-backfill"
              />
            </div>
            {backfillPollingJobId && backfillProgress && (
              <div className="p-2 bg-slate-100 rounded text-xs text-gray-700" data-testid="div-legacy-backfill-progress">
                Pages: {backfillProgress.pages} · Scanned: {backfillProgress.scanned} · Ingested: {backfillProgress.ingested} · Skipped: {backfillProgress.skipped}
              </div>
            )}
          </div>
        )}
    </>
  );
}
