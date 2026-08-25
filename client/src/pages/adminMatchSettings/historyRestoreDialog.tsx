// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { GuardrailAcknowledgementRequiredError, SCOPE_LABEL, formatNumber, rowKey } from "./guardrails";
import type { ChangeHistoryBag } from "./useChangeHistory";
import type { CoreSettingsBag } from "./useCoreSettings";

type HistoryRestoreDialogProps = {
  historyDomain: ChangeHistoryBag;
  core: CoreSettingsBag;
  toast: ReturnType<typeof useToast>["toast"];
};

export function HistoryRestoreDialog(props: HistoryRestoreDialogProps) {
  const { history, pendingThresholdRestoreRowId, setPendingThresholdRestoreRowId, setRestoringThresholdRowId } = props.historyDomain;
  const { data, setSavingKey, updateMutation } = props.core;
  const { toast } = props;
  return (
    <>
      <AlertDialog
        open={pendingThresholdRestoreRowId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingThresholdRestoreRowId(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-history-restore-confirm">
          {(() => {
            const pendingRow = (history?.rows || []).find(
              (r) => r.id === pendingThresholdRestoreRowId,
            );
            if (!pendingRow) return null;
            const currentRow = data?.rows.find(
              (r) => r.scope === pendingRow.source && r.key === pendingRow.settingKey,
            );
            const currentValue = currentRow?.persistedValue ?? null;
            const targetValue = pendingRow.oldValue;
            const isNoOp = currentValue === targetValue;
            const changedAtLabel = new Date(pendingRow.changedAt).toLocaleString();
            const descriptorLabel =
              data?.descriptors.find((d) => d.key === pendingRow.settingKey)?.label ??
              pendingRow.settingKey;
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restore threshold to previous value?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-3 text-sm text-gray-700">
                      <div>
                        Restore{" "}
                        <span className="font-medium">{descriptorLabel}</span>{" "}
                        (<span className="font-mono">{pendingRow.settingKey}</span>) on{" "}
                        <span className="font-medium">{SCOPE_LABEL[pendingRow.source]}</span> to
                        the value captured at{" "}
                        <span className="font-medium">{changedAtLabel}</span>.
                      </div>
                      <div className="rounded border border-gray-200 bg-gray-50 p-3">
                        <div className="flex items-center gap-2 text-sm font-mono">
                          <span
                            className="text-gray-600"
                            data-testid="text-history-restore-confirm-current"
                          >
                            {currentValue === null ? (
                              <span className="italic">cleared</span>
                            ) : (
                              formatNumber(currentValue)
                            )}
                          </span>
                          <span className="text-gray-400">→</span>
                          <span
                            className="text-emerald-700 font-semibold"
                            data-testid="text-history-restore-confirm-target"
                          >
                            {targetValue === null ? (
                              <span className="italic">cleared</span>
                            ) : (
                              formatNumber(targetValue)
                            )}
                          </span>
                        </div>
                        {isNoOp && (
                          <div
                            className="mt-2 text-xs text-gray-600"
                            data-testid="text-history-restore-confirm-noop"
                          >
                            No changes — the current value already matches this snapshot.
                          </div>
                        )}
                      </div>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-history-restore-confirm-cancel">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={isNoOp || updateMutation.isPending}
                    onClick={() => {
                      const sourceRowId = pendingRow.id;
                      setRestoringThresholdRowId(sourceRowId);
                      setSavingKey(rowKey(pendingRow.source, pendingRow.settingKey));
                      setPendingThresholdRestoreRowId(null);
                      updateMutation.mutate(
                        {
                          scope: pendingRow.source,
                          key: pendingRow.settingKey,
                          value: targetValue,
                          restoreFromHistoryId: sourceRowId,
                        },
                        {
                          onSuccess: () => {
                            toast({
                              title: "Snapshot restored",
                              description: `Restored ${pendingRow.settingKey} to ${
                                targetValue === null ? "(cleared)" : formatNumber(targetValue)
                              } (snapshot from ${changedAtLabel})`,
                              duration: 5000,
                            });
                          },
                          onError: (err: unknown) => {
                            if (err instanceof GuardrailAcknowledgementRequiredError) {
                              return;
                            }
                            const message =
                              err instanceof Error ? err.message : "Failed to restore";
                            toast({
                              title: "Restore failed",
                              description: message,
                              variant: "destructive",
                              duration: 7000,
                            });
                          },
                          onSettled: () => {
                            setRestoringThresholdRowId(null);
                          },
                        },
                      );
                    }}
                    data-testid="button-history-restore-confirm-apply"
                  >
                    {isNoOp ? "Nothing to restore" : "Restore"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
