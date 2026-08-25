// Extracted verbatim from MatchSettings.tsx (F11B decomposition).
import { LastEditedBadge } from "@/components/LastEditedBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, Save } from "lucide-react";
import type { CoreSettingsBag } from "./useCoreSettings";
import type { HeatmapCoverageBag } from "./useHeatmapCoverage";

type HeatmapCoverageCardProps = {
  heatmap: HeatmapCoverageBag;
  core: CoreSettingsBag;
};

export function HeatmapCoverageCard(props: HeatmapCoverageCardProps) {
  const { heatmapCoverageDirty, heatmapCoverageEffective, heatmapCoverageStatus, saveHeatmapCoverageMutation, setHeatmapCoverageDirty, setHeatmapCoverageDraft, slackChannels, updateHeatmapCoverageDraft } = props.heatmap;
  const { data, error } = props.core;
  return (
    <>
        {heatmapCoverageEffective && (
          <div
            className="bg-card rounded-lg border shadow-sm overflow-hidden mb-6"
            data-testid="card-heatmap-coverage-check"
          >
            <div className="px-4 py-3 border-b bg-muted/50 flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <h3
                className="text-sm font-semibold text-foreground"
                data-testid="text-heatmap-coverage-check-title"
              >
                Heatmap coverage check (post-backfill)
              </h3>
              {heatmapCoverageStatus?.lastEdited && (
                <div className="ml-auto">
                  <LastEditedBadge info={heatmapCoverageStatus.lastEdited} />
                </div>
              )}
            </div>
            <div className="px-4 py-4 space-y-4 text-sm">
              <p className="text-[12px] text-muted-foreground" data-testid="text-heatmap-coverage-check-description">
                After every non-dry-run heatmap backfill, an automated check
                recomputes per-location coverage gaps and posts a Slack alert if
                any remain. Adjust the toggle, timing, retry limit, and Slack
                channel below.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2" htmlFor="toggle-heatmap-coverage-enabled">
                  <input
                    id="toggle-heatmap-coverage-enabled"
                    type="checkbox"
                    checked={heatmapCoverageEffective.enabled}
                    onChange={(e) =>
                      updateHeatmapCoverageDraft({ enabled: e.target.checked })
                    }
                    className="h-4 w-4"
                    data-testid="toggle-heatmap-coverage-enabled"
                  />
                  <span className="font-medium">Enable post-backfill check</span>
                </label>
                <span className="text-[11px] text-muted-foreground">
                  When off, no coverage check job is enqueued after a backfill
                  completes. (Default:{" "}
                  {heatmapCoverageStatus?.defaults.enabled ? "on" : "off"})
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2" htmlFor="toggle-heatmap-coverage-alert-on-success">
                  <input
                    id="toggle-heatmap-coverage-alert-on-success"
                    type="checkbox"
                    checked={heatmapCoverageEffective.alertOnSuccess}
                    onChange={(e) =>
                      updateHeatmapCoverageDraft({ alertOnSuccess: e.target.checked })
                    }
                    className="h-4 w-4"
                    data-testid="toggle-heatmap-coverage-alert-on-success"
                  />
                  <span className="font-medium">Also alert on clean coverage</span>
                </label>
                <span className="text-[11px] text-muted-foreground">
                  When off, Slack only fires if gaps remain. (Default:{" "}
                  {heatmapCoverageStatus?.defaults.alertOnSuccess ? "on" : "off"})
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="input-heatmap-coverage-delay"
                    className="text-[12px] font-medium text-foreground"
                  >
                    Initial delay (seconds)
                  </label>
                  <Input
                    id="input-heatmap-coverage-delay"
                    type="number"
                    min={0}
                    max={86400}
                    value={heatmapCoverageEffective.delaySeconds}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      updateHeatmapCoverageDraft({
                        delaySeconds: Number.isFinite(n) ? n : 0,
                      });
                    }}
                    className="h-8 text-[12px]"
                    data-testid="input-heatmap-coverage-delay-seconds"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    How long to wait after the backfill before the first check.
                    Default {heatmapCoverageStatus?.defaults.delaySeconds}s.
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="input-heatmap-coverage-recheck"
                    className="text-[12px] font-medium text-foreground"
                  >
                    Recheck interval (seconds)
                  </label>
                  <Input
                    id="input-heatmap-coverage-recheck"
                    type="number"
                    min={30}
                    max={86400}
                    value={heatmapCoverageEffective.recheckIntervalSeconds}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      updateHeatmapCoverageDraft({
                        recheckIntervalSeconds: Number.isFinite(n) ? n : 30,
                      });
                    }}
                    className="h-8 text-[12px]"
                    data-testid="input-heatmap-coverage-recheck-seconds"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Wait this long between rechecks if refresh jobs haven't
                    drained. Default{" "}
                    {heatmapCoverageStatus?.defaults.recheckIntervalSeconds}s.
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="input-heatmap-coverage-max-attempts"
                    className="text-[12px] font-medium text-foreground"
                  >
                    Max attempts
                  </label>
                  <Input
                    id="input-heatmap-coverage-max-attempts"
                    type="number"
                    min={1}
                    max={50}
                    value={heatmapCoverageEffective.maxAttempts}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      updateHeatmapCoverageDraft({
                        maxAttempts: Number.isFinite(n) ? n : 1,
                      });
                    }}
                    className="h-8 text-[12px]"
                    data-testid="input-heatmap-coverage-max-attempts"
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Give up after this many recheck cycles. Default{" "}
                    {heatmapCoverageStatus?.defaults.maxAttempts}.
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="select-heatmap-coverage-slack-channel"
                  className="text-[12px] font-medium text-foreground"
                >
                  Slack channel for coverage alerts
                </label>
                <Select
                  value={heatmapCoverageEffective.slackChannelId ?? "__none__"}
                  onValueChange={(v) =>
                    updateHeatmapCoverageDraft({
                      slackChannelId: v === "__none__" ? null : v,
                    })
                  }
                >
                  <SelectTrigger
                    id="select-heatmap-coverage-slack-channel"
                    className="w-full sm:w-96 h-8 text-[12px]"
                    data-testid="select-heatmap-coverage-slack-channel"
                  >
                    <SelectValue placeholder="Select a channel..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      — None (Slack alerts disabled) —
                    </SelectItem>
                    {slackChannels.map((c) => (
                      <SelectItem
                        key={c.id}
                        value={c.id}
                        data-testid={`option-heatmap-coverage-channel-${c.id}`}
                      >
                        #{c.name}
                        {c.isPrivate ? " (private)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-muted-foreground">
                  Leave as "None" to skip Slack alerts entirely. Bot must be a
                  member of the channel you pick.
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                <Button
                  size="sm"
                  onClick={() =>
                    heatmapCoverageEffective &&
                    saveHeatmapCoverageMutation.mutate(heatmapCoverageEffective)
                  }
                  disabled={
                    !heatmapCoverageDirty ||
                    saveHeatmapCoverageMutation.isPending
                  }
                  data-testid="button-save-heatmap-coverage-settings"
                >
                  <Save className="w-3 h-3 mr-1.5" />
                  {saveHeatmapCoverageMutation.isPending ? "Saving…" : "Save changes"}
                </Button>
                {heatmapCoverageDirty && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setHeatmapCoverageDirty(false);
                      setHeatmapCoverageDraft(
                        heatmapCoverageStatus?.settings ?? null,
                      );
                    }}
                    disabled={saveHeatmapCoverageMutation.isPending}
                    data-testid="button-cancel-heatmap-coverage-settings"
                  >
                    Cancel
                  </Button>
                )}
                {saveHeatmapCoverageMutation.isError && (
                  <span
                    className="text-[11px] text-red-700"
                    data-testid="text-heatmap-coverage-save-error"
                  >
                    {(saveHeatmapCoverageMutation.error as Error)?.message ||
                      "Failed to save"}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
    </>
  );
}
