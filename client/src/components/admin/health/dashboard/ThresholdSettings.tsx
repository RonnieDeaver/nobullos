// Extracted verbatim from HealthDashboardSection.tsx (F11D decomposition, task #4160).
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RotateCcw, Save } from "lucide-react";
import { useState, useEffect } from "react";
import type { ThresholdConfig } from "./types";

export function ThresholdSettings({ thresholds, onSave, onReset, isSaving, isResetting }: {
  thresholds: ThresholdConfig;
  onSave: (config: ThresholdConfig) => void;
  onReset: () => void;
  isSaving: boolean;
  isResetting: boolean;
}) {
  const [form, setForm] = useState<ThresholdConfig>(thresholds);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  useEffect(() => {
    setForm(thresholds);
  }, [thresholds]);

  const hasChanges = JSON.stringify(form) !== JSON.stringify(thresholds);

  const validationErrors: string[] = [];
  if (form.dbLatencyWarningMs < 1) validationErrors.push("DB latency warning must be at least 1ms");
  if (form.dbLatencyCriticalMs < 1) validationErrors.push("DB latency critical must be at least 1ms");
  if (form.dbLatencyWarningMs >= form.dbLatencyCriticalMs) validationErrors.push("Warning threshold must be less than critical");
  if (form.consecutiveFailuresWarning < 1) validationErrors.push("Consecutive failures warning must be at least 1");
  if (form.consecutiveFailuresCritical < 1) validationErrors.push("Consecutive failures critical must be at least 1");
  if (form.consecutiveFailuresWarning >= form.consecutiveFailuresCritical) validationErrors.push("Warning failures must be less than critical");
  if (form.manualTimeoutWindowWarning < 1) validationErrors.push("Manual timeout warning must be at least 1");
  if (form.manualTimeoutWindowCritical < 1) validationErrors.push("Manual timeout critical must be at least 1");
  if (form.manualTimeoutWindowWarning >= form.manualTimeoutWindowCritical) validationErrors.push("Manual timeout warning must be less than critical");
  if (form.manualWaitP95WarningMs < 1) validationErrors.push("Manual wait p95 warning must be at least 1ms");
  if (form.manualWaitP95CriticalMs < 1) validationErrors.push("Manual wait p95 critical must be at least 1ms");
  if (form.manualWaitP95WarningMs >= form.manualWaitP95CriticalMs) validationErrors.push("Manual wait p95 warning must be less than critical");
  if (form.backgroundIngestionSaturationWindowWarning < 1) validationErrors.push("Background saturation warning must be at least 1");
  if (form.backgroundIngestionSaturationWindowCritical < 1) validationErrors.push("Background saturation critical must be at least 1");
  if (form.backgroundIngestionSaturationWindowWarning >= form.backgroundIngestionSaturationWindowCritical) validationErrors.push("Background saturation warning must be less than critical");
  if (form.manualDelayedByBackgroundWindowWarning < 1) validationErrors.push("Delayed-by-background warning must be at least 1");
  if (form.manualDelayedByBackgroundWindowCritical < 1) validationErrors.push("Delayed-by-background critical must be at least 1");
  if (form.manualDelayedByBackgroundWindowWarning >= form.manualDelayedByBackgroundWindowCritical) validationErrors.push("Delayed-by-background warning must be less than critical");
  if (form.perEntryPointManualTimeoutWindowWarning < 1) validationErrors.push("Per-entry-point timeout warning must be at least 1");
  if (form.perEntryPointManualTimeoutWindowCritical < 1) validationErrors.push("Per-entry-point timeout critical must be at least 1");
  if (form.perEntryPointManualTimeoutWindowWarning >= form.perEntryPointManualTimeoutWindowCritical) validationErrors.push("Per-entry-point timeout warning must be less than critical");
  if (form.perEntryPointManualDelayedByBackgroundWindowWarning < 1) validationErrors.push("Per-entry-point delayed warning must be at least 1");
  if (form.perEntryPointManualDelayedByBackgroundWindowCritical < 1) validationErrors.push("Per-entry-point delayed critical must be at least 1");
  if (form.perEntryPointManualDelayedByBackgroundWindowWarning >= form.perEntryPointManualDelayedByBackgroundWindowCritical) validationErrors.push("Per-entry-point delayed warning must be less than critical");
  if (!Number.isInteger(form.manualReserveWindowSamples) || form.manualReserveWindowSamples < 2 || form.manualReserveWindowSamples > 120) validationErrors.push("Window samples must be an integer between 2 and 120");
  // Task #1261
  if (form.apiPoolWaitWarningMs < 1) validationErrors.push("API pool wait warning must be at least 1ms");
  if (form.apiPoolWaitCriticalMs < 1) validationErrors.push("API pool wait critical must be at least 1ms");
  if (form.apiPoolWaitWarningMs >= form.apiPoolWaitCriticalMs) validationErrors.push("API pool wait warning must be less than critical");
  if (!Number.isInteger(form.apiPoolWaitWindowSamples) || form.apiPoolWaitWindowSamples < 2 || form.apiPoolWaitWindowSamples > 120) validationErrors.push("API pool wait window samples must be an integer between 2 and 120");
  const isValid = validationErrors.length === 0;
  const windowMinutes = Math.round((form.manualReserveWindowSamples * 30) / 60);

  return (
    <div className="space-y-4" data-testid="section-threshold-settings">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="dbLatencyWarningMs">DB Latency Warning (ms)</Label>
          <Input
            id="dbLatencyWarningMs"
            type="number"
            min={1}
            value={form.dbLatencyWarningMs}
            onChange={(e) => setForm({ ...form, dbLatencyWarningMs: parseInt(e.target.value) || 0 })}
            data-testid="input-db-latency-warning"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="dbLatencyCriticalMs">DB Latency Critical (ms)</Label>
          <Input
            id="dbLatencyCriticalMs"
            type="number"
            min={1}
            value={form.dbLatencyCriticalMs}
            onChange={(e) => setForm({ ...form, dbLatencyCriticalMs: parseInt(e.target.value) || 0 })}
            data-testid="input-db-latency-critical"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="consecutiveFailuresWarning">Consecutive Failures Warning</Label>
          <Input
            id="consecutiveFailuresWarning"
            type="number"
            min={1}
            value={form.consecutiveFailuresWarning}
            onChange={(e) => setForm({ ...form, consecutiveFailuresWarning: parseInt(e.target.value) || 0 })}
            data-testid="input-failures-warning"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="consecutiveFailuresCritical">Consecutive Failures Critical</Label>
          <Input
            id="consecutiveFailuresCritical"
            type="number"
            min={1}
            value={form.consecutiveFailuresCritical}
            onChange={(e) => setForm({ ...form, consecutiveFailuresCritical: parseInt(e.target.value) || 0 })}
            data-testid="input-failures-critical"
          />
        </div>
      </div>
      <div className="pt-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Manual Sync Reserve
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="manualTimeoutWindowWarning">Manual Timeouts / window — Warning</Label>
            <Input
              id="manualTimeoutWindowWarning"
              type="number"
              min={1}
              value={form.manualTimeoutWindowWarning}
              onChange={(e) => setForm({ ...form, manualTimeoutWindowWarning: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-timeout-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manualTimeoutWindowCritical">Manual Timeouts / window — Critical</Label>
            <Input
              id="manualTimeoutWindowCritical"
              type="number"
              min={1}
              value={form.manualTimeoutWindowCritical}
              onChange={(e) => setForm({ ...form, manualTimeoutWindowCritical: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-timeout-critical"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manualWaitP95WarningMs">Manual Wait P95 (ms) — Warning</Label>
            <Input
              id="manualWaitP95WarningMs"
              type="number"
              min={1}
              value={form.manualWaitP95WarningMs}
              onChange={(e) => setForm({ ...form, manualWaitP95WarningMs: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-wait-p95-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manualWaitP95CriticalMs">Manual Wait P95 (ms) — Critical</Label>
            <Input
              id="manualWaitP95CriticalMs"
              type="number"
              min={1}
              value={form.manualWaitP95CriticalMs}
              onChange={(e) => setForm({ ...form, manualWaitP95CriticalMs: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-wait-p95-critical"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="backgroundIngestionSaturationWindowWarning">Background Saturation / window — Warning</Label>
            <Input
              id="backgroundIngestionSaturationWindowWarning"
              type="number"
              min={1}
              value={form.backgroundIngestionSaturationWindowWarning}
              onChange={(e) => setForm({ ...form, backgroundIngestionSaturationWindowWarning: parseInt(e.target.value) || 0 })}
              data-testid="input-background-saturation-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="backgroundIngestionSaturationWindowCritical">Background Saturation / window — Critical</Label>
            <Input
              id="backgroundIngestionSaturationWindowCritical"
              type="number"
              min={1}
              value={form.backgroundIngestionSaturationWindowCritical}
              onChange={(e) => setForm({ ...form, backgroundIngestionSaturationWindowCritical: parseInt(e.target.value) || 0 })}
              data-testid="input-background-saturation-critical"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manualDelayedByBackgroundWindowWarning">Delayed by Background / window — Warning</Label>
            <Input
              id="manualDelayedByBackgroundWindowWarning"
              type="number"
              min={1}
              value={form.manualDelayedByBackgroundWindowWarning}
              onChange={(e) => setForm({ ...form, manualDelayedByBackgroundWindowWarning: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-delayed-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manualDelayedByBackgroundWindowCritical">Delayed by Background / window — Critical</Label>
            <Input
              id="manualDelayedByBackgroundWindowCritical"
              type="number"
              min={1}
              value={form.manualDelayedByBackgroundWindowCritical}
              onChange={(e) => setForm({ ...form, manualDelayedByBackgroundWindowCritical: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-delayed-critical"
            />
          </div>
        </div>
      </div>
      <div className="pt-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Per Entry Point (per-worker)
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Tighter, per-worker thresholds catch a single starved entry point even when overall counts stay below the global thresholds above.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="perEntryPointManualTimeoutWindowWarning">Per-EP Manual Timeouts / window — Warning</Label>
            <Input
              id="perEntryPointManualTimeoutWindowWarning"
              type="number"
              min={1}
              value={form.perEntryPointManualTimeoutWindowWarning}
              onChange={(e) => setForm({ ...form, perEntryPointManualTimeoutWindowWarning: parseInt(e.target.value) || 0 })}
              data-testid="input-per-ep-timeout-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="perEntryPointManualTimeoutWindowCritical">Per-EP Manual Timeouts / window — Critical</Label>
            <Input
              id="perEntryPointManualTimeoutWindowCritical"
              type="number"
              min={1}
              value={form.perEntryPointManualTimeoutWindowCritical}
              onChange={(e) => setForm({ ...form, perEntryPointManualTimeoutWindowCritical: parseInt(e.target.value) || 0 })}
              data-testid="input-per-ep-timeout-critical"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="perEntryPointManualDelayedByBackgroundWindowWarning">Per-EP Delayed by Background / window — Warning</Label>
            <Input
              id="perEntryPointManualDelayedByBackgroundWindowWarning"
              type="number"
              min={1}
              value={form.perEntryPointManualDelayedByBackgroundWindowWarning}
              onChange={(e) => setForm({ ...form, perEntryPointManualDelayedByBackgroundWindowWarning: parseInt(e.target.value) || 0 })}
              data-testid="input-per-ep-delayed-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="perEntryPointManualDelayedByBackgroundWindowCritical">Per-EP Delayed by Background / window — Critical</Label>
            <Input
              id="perEntryPointManualDelayedByBackgroundWindowCritical"
              type="number"
              min={1}
              value={form.perEntryPointManualDelayedByBackgroundWindowCritical}
              onChange={(e) => setForm({ ...form, perEntryPointManualDelayedByBackgroundWindowCritical: parseInt(e.target.value) || 0 })}
              data-testid="input-per-ep-delayed-critical"
            />
          </div>
        </div>
      </div>
      <div className="pt-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          API Pool Pressure
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Alerts when the dashboard's <code>apiPoolWaitMs</code> stays at or
          above the threshold across every sample in the window — i.e. the
          shared API DB pool is sustained-saturated.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="apiPoolWaitWarningMs">API Pool Wait (ms) — Warning</Label>
            <Input
              id="apiPoolWaitWarningMs"
              type="number"
              min={1}
              value={form.apiPoolWaitWarningMs}
              onChange={(e) => setForm({ ...form, apiPoolWaitWarningMs: parseInt(e.target.value) || 0 })}
              data-testid="input-api-pool-wait-warning"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiPoolWaitCriticalMs">API Pool Wait (ms) — Critical</Label>
            <Input
              id="apiPoolWaitCriticalMs"
              type="number"
              min={1}
              value={form.apiPoolWaitCriticalMs}
              onChange={(e) => setForm({ ...form, apiPoolWaitCriticalMs: parseInt(e.target.value) || 0 })}
              data-testid="input-api-pool-wait-critical"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiPoolWaitWindowSamples">Window samples (30s each)</Label>
            <Input
              id="apiPoolWaitWindowSamples"
              type="number"
              min={2}
              max={120}
              value={form.apiPoolWaitWindowSamples}
              onChange={(e) => setForm({ ...form, apiPoolWaitWindowSamples: parseInt(e.target.value) || 0 })}
              data-testid="input-api-pool-wait-window-samples"
            />
          </div>
        </div>
      </div>
      <div className="pt-2">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Reserve Pressure Window
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="manualReserveWindowSamples">Window samples (30s each)</Label>
            <Input
              id="manualReserveWindowSamples"
              type="number"
              min={2}
              max={120}
              value={form.manualReserveWindowSamples}
              onChange={(e) => setForm({ ...form, manualReserveWindowSamples: parseInt(e.target.value) || 0 })}
              data-testid="input-manual-reserve-window-samples"
            />
            <p className="text-xs text-muted-foreground">
              Approximately {windowMinutes} minute{windowMinutes === 1 ? "" : "s"} rolling window.
            </p>
          </div>
        </div>
      </div>
      {hasChanges && !isValid && (
        <div className="text-sm text-red-600 space-y-1" data-testid="text-validation-errors">
          {validationErrors.map((err, i) => (
            <p key={i}>{err}</p>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          onClick={() => onSave(form)}
          disabled={!hasChanges || !isValid || isSaving}
          size="sm"
          data-testid="button-save-thresholds"
        >
          <Save className="w-3 h-3 mr-1" />
          {isSaving ? "Saving..." : "Save Thresholds"}
        </Button>
        {/* Task #4357: resetting wipes every tuned threshold, so it confirms
            before firing — it sits one click away from routine Save. */}
        <Button
          onClick={() => setConfirmResetOpen(true)}
          variant="outline"
          size="sm"
          disabled={isResetting}
          data-testid="button-reset-thresholds"
        >
          <RotateCcw className="w-3 h-3 mr-1" />
          {isResetting ? "Resetting..." : "Reset to Defaults"}
        </Button>
        <AlertDialog open={confirmResetOpen} onOpenChange={setConfirmResetOpen}>
          <AlertDialogContent data-testid="dialog-confirm-reset-thresholds">
            <AlertDialogHeader>
              <AlertDialogTitle>Reset alert thresholds to defaults?</AlertDialogTitle>
              <AlertDialogDescription>
                Every tuned warning/critical threshold on this card goes back to
                the built-in defaults immediately. Current values are not saved
                anywhere — re-tuning means re-entering them by hand.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-reset-thresholds-abort">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="button-reset-thresholds-confirm"
                onClick={() => {
                  setConfirmResetOpen(false);
                  onReset();
                  setForm(thresholds);
                }}
              >
                Reset to defaults
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}