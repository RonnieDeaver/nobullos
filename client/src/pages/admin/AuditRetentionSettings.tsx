import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { formatEditorAttribution } from "@/lib/auditEditorFormat";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { ArrowLeft, Archive, AlertTriangle, History, Activity, Trash2, ChevronRight, Loader2, Database } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type LastEditedUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

type LastEdited = {
  updatedAt: string | null;
  updatedBy: LastEditedUser | null;
};

type RetentionResponse = {
  retentionDays: number;
  source: "setting" | "env" | "default";
  defaultDays: number;
  envDays: number | null;
  minDays: number;
  maxDays: number;
  lastEdited: LastEdited;
};

type AuditEntry = {
  id: string;
  settingKey: string;
  scope: string | null;
  changedBy: string | null;
  oldValues: any;
  newValues: any;
  changedAt: string | null;
  changedByName: string | null;
  changedByEmail: string | null;
};

type HistoryResponse = { history: AuditEntry[] };

type AuditTableStats = {
  totalRows: number;
  oldestChangedAt: string | null;
  rowsOlderThanRetention: number;
};

type AuditSettingKeyBreakdown = {
  settingKey: string;
  totalRows: number;
  oldestChangedAt: string | null;
  rowsOlderThanRetention: number;
};

type AuditRetentionStatsResponse = {
  retentionDays: number;
  previewDays: number | null;
  adminSettingAudit: AuditTableStats;
  staleLeaseThresholdAudit: AuditTableStats;
  queueTimingAudit: AuditTableStats;
  adminSettingAuditByKey: AuditSettingKeyBreakdown[];
  adminSettingAuditByKeyLimit: number;
  adminSettingAuditDistinctKeys: number;
};

type PruneEvent = {
  at: string;
  removed: number;
  maxEntries: number;
  maxAgeDays: number;
  trigger?: "scheduled" | "manual" | "save";
  triggeredBy?: string | null;
  triggeredByName?: string | null;
};

type AnomalyDecision =
  | "alerted"
  | "skipped_disabled"
  | "skipped_zero_removed"
  | "skipped_below_floor"
  | "skipped_below_ratio"
  | "skipped_cooldown"
  | "skipped_send_failed"
  | "skipped_dispatcher_skipped"
  | "skipped_no_event";

type AnomalyConfig = {
  enabled: boolean;
  minRows: number;
  ratioMultiplier: number;
  baselineWindow: number;
  cooldownMinutes: number;
};

type PruneAnomalySummary = {
  event: PruneEvent | null;
  decision: AnomalyDecision;
  baseline: { sampleSize: number; averageRemoved: number; maxRemoved: number };
  ratioObserved: number | null;
  config: AnomalyConfig;
  lastAlertedAt: string | null;
  skipReason?: string;
};

type PruneEventsResponse = {
  adminSettingAudit: { events: PruneEvent[]; anomaly?: PruneAnomalySummary };
  staleLeaseThresholdAudit: { events: PruneEvent[]; anomaly?: PruneAnomalySummary };
  queueTimingAudit: { events: PruneEvent[]; anomaly?: PruneAnomalySummary };
  blockedIpAudit: { events: PruneEvent[]; maxEntriesPerIp: number; anomaly?: PruneAnomalySummary };
  clientContactsAudit: { events: PruneEvent[]; retentionDays: number; minPerContact: number; anomaly?: PruneAnomalySummary };
  anomalyConfig?: AnomalyConfig;
};

type ClientContactsAuditRetentionResponse = {
  retentionDays: number;
  retentionDaysSource: "setting" | "env" | "default";
  retentionDaysUpdatedAt: string | null;
  minPerContact: number;
  minPerContactSource: "setting" | "env" | "default";
  minPerContactUpdatedAt: string | null;
  defaultRetentionDays: number;
  defaultMinPerContact: number;
  minDays: number;
  maxDays: number;
  minPerContactMin: number;
  minPerContactMax: number;
  stats: {
    totalRows: number;
    oldestCreatedAt: string | null;
    rowsOlderThanRetention: number;
    contactsWithFloorRows: number;
    retentionDays: number;
    minPerContact: number;
    previewDays: number | null;
    previewMinPerContact: number | null;
  };
};

type PruneNowResponse = {
  result: {
    adminSettingAuditDeleted: number;
    staleLeaseThresholdAuditDeleted: number;
    queueTimingAuditDeleted: number;
    blockedIpAuditDeleted: number | null;
    clientContactsAuditDeleted: number | null;
    retentionDays: number;
  };
};

type BlockedIpAuditRetentionResponse = {
  maxEntriesPerIp: number;
  source: "setting" | "env" | "default";
  defaultMax: number;
  envMax: number | null;
  minMax: number;
  maxMax: number;
  lastEdited: LastEdited;
};

function formatUser(u: LastEditedUser | null, fallback: string | null = null): string {
  if (!u) return fallback ?? "—";
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || u.id;
}

function describeSource(source: RetentionResponse["source"], envDays: number | null, defaultDays: number): string {
  if (source === "setting") return "Saved by an admin";
  if (source === "env") return `Inherited from ADMIN_AUDIT_RETENTION_DAYS env (${envDays} days)`;
  return `Built-in default (${defaultDays} days)`;
}

function formatTrigger(t: PruneEvent["trigger"]): string {
  if (t === "manual") return "Manual";
  if (t === "save") return "After save";
  return "Scheduled";
}

function draftValidForPreview(draft: string, min: number, max: number): boolean {
  const n = Number.parseInt(draft, 10);
  return Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max;
}

function formatOldest(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  return `${d.toLocaleString()} (${days}d ago)`;
}

function summarizeLastRun(events: PruneEvent[] | undefined): string {
  if (!events || events.length === 0) return "Never";
  const e = events[0];
  return `${new Date(e.at).toLocaleString()} · removed ${e.removed.toLocaleString()}`;
}

function describeDecision(d: AnomalyDecision): { label: string; tone: "alert" | "ok" | "muted" } {
  switch (d) {
    case "alerted":
      return { label: "Anomaly alerted", tone: "alert" };
    case "skipped_cooldown":
      return { label: "Threshold crossed (cooldown)", tone: "alert" };
    case "skipped_send_failed":
      return { label: "Threshold crossed (send failed)", tone: "alert" };
    case "skipped_dispatcher_skipped":
      return { label: "Threshold crossed (dispatcher skipped)", tone: "alert" };
    case "skipped_below_floor":
      return { label: "Below row floor", tone: "ok" };
    case "skipped_below_ratio":
      return { label: "Below ratio threshold", tone: "ok" };
    case "skipped_zero_removed":
      return { label: "0 rows removed", tone: "muted" };
    case "skipped_disabled":
      return { label: "Anomaly alerts disabled", tone: "muted" };
    case "skipped_no_event":
    default:
      return { label: "No prune events yet", tone: "muted" };
  }
}

function AnomalyBadge({ anomaly, testId }: { anomaly: PruneAnomalySummary | undefined; testId: string }) {
  if (!anomaly) return null;
  const { label, tone } = describeDecision(anomaly.decision);
  const toneClass =
    tone === "alert"
      ? "bg-amber-50 border-amber-200 text-amber-800"
      : tone === "ok"
      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
      : "bg-muted/50 border-border text-muted-foreground";
  const cfg = anomaly.config;
  const baselineLine =
    anomaly.baseline.sampleSize > 0
      ? `Baseline avg ${anomaly.baseline.averageRemoved.toFixed(0)} (max ${anomaly.baseline.maxRemoved.toLocaleString()}, n=${anomaly.baseline.sampleSize})`
      : "No prior non-zero runs in baseline window";
  const ratioLine =
    anomaly.ratioObserved !== null
      ? `Latest run is ${anomaly.ratioObserved.toFixed(1)}× baseline avg`
      : "Ratio: n/a";
  const thresholdLine = `Thresholds: ≥${cfg.minRows.toLocaleString()} rows AND ≥${cfg.ratioMultiplier}× baseline (cooldown ${cfg.cooldownMinutes}m)`;
  return (
    <div
      className={`mt-2 rounded-md border text-xs px-2 py-1.5 ${toneClass}`}
      data-testid={`anomaly-summary-${testId}`}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span
          className="font-medium"
          data-testid={`anomaly-decision-${testId}`}
        >
          {label}
        </span>
        {anomaly.lastAlertedAt && (
          <span
            className="text-amber-900 bg-amber-100 border border-amber-200 rounded-full px-2 py-0.5"
            data-testid={`anomaly-last-alerted-${testId}`}
            title={new Date(anomaly.lastAlertedAt).toLocaleString()}
          >
            Last alerted {new Date(anomaly.lastAlertedAt).toLocaleString()}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-xs opacity-90" data-testid={`anomaly-baseline-${testId}`}>
        {baselineLine} · {ratioLine}
      </div>
      <div className="text-xs opacity-75" data-testid={`anomaly-thresholds-${testId}`}>
        {thresholdLine}
      </div>
      {anomaly.skipReason && anomaly.decision !== "alerted" && (
        <div className="text-xs opacity-75" data-testid={`anomaly-skip-reason-${testId}`}>
          {anomaly.skipReason}
        </div>
      )}
    </div>
  );
}

function PruneTable({
  title,
  testId,
  events,
  showWindow,
  windowLabel,
  onSelectEvent,
  anomaly,
  manualOnly,
}: {
  title: string;
  testId: string;
  events: PruneEvent[];
  showWindow: "days" | "perIp";
  windowLabel?: string;
  onSelectEvent?: (e: PruneEvent, table: string) => void;
  anomaly?: PruneAnomalySummary;
  manualOnly?: boolean;
}) {
  const visibleEvents = manualOnly ? events.filter((e) => e.trigger === "manual") : events;
  return (
    <div className="border rounded-md p-3" data-testid={`panel-prune-${testId}`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground" data-testid={`text-prune-title-${testId}`}>
          {title}
        </h3>
        <span className="text-xs text-muted-foreground" data-testid={`text-prune-last-${testId}`}>
          Last run: {summarizeLastRun(visibleEvents)}
        </span>
      </div>
      {visibleEvents.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid={`text-no-prune-${testId}`}>
          {manualOnly ? "No manual prunes recorded yet." : "No prune runs recorded yet."}
        </div>
      ) : (
        <ul className="divide-y text-xs">
          {visibleEvents.slice(0, 10).map((e, idx) => {
            const clickable = !!onSelectEvent && e.trigger === "manual";
            return (
            <li
              key={`${e.at}-${idx}`}
              className={`py-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 ${clickable ? "hover:bg-muted/50 cursor-pointer rounded px-1" : ""}`}
              data-testid={`row-prune-${testId}-${idx}`}
              onClick={clickable ? () => onSelectEvent!(e, title) : undefined}
              role={clickable ? "button" : undefined}
            >
              <span className="text-muted-foreground whitespace-nowrap">{new Date(e.at).toLocaleString()}</span>
              <span
                className="font-medium text-foreground"
                data-testid={`text-prune-removed-${testId}-${idx}`}
              >
                {e.removed.toLocaleString()} removed
              </span>
              <span className="text-muted-foreground whitespace-nowrap">
                {showWindow === "days"
                  ? `${e.maxAgeDays}d window`
                  : `keep ${e.maxEntries}/IP`}
              </span>
              <span
                className="text-muted-foreground whitespace-nowrap"
                data-testid={`text-prune-trigger-${testId}-${idx}`}
              >
                {formatTrigger(e.trigger)}
                {e.triggeredByName ? ` · ${e.triggeredByName}` : ""}
              </span>
            </li>
            );
          })}
        </ul>
      )}
      {windowLabel && (
        <div className="text-xs text-muted-foreground mt-2">{windowLabel}</div>
      )}
      <AnomalyBadge anomaly={anomaly} testId={testId} />
    </div>
  );
}

type TrimAlertOverride = {
  scopePattern: string;
  minTrims?: number | null;
  perIpCooldownMinutes?: number | null;
};

type TrimAlertConfigResponse = {
  enabled: boolean;
  email: string;
  emailRecipients: string[];
  minTrims: number;
  batchWindowSeconds: number;
  perIpCooldownMinutes: number;
  overrides: TrimAlertOverride[];
};

type OverrideDraft = {
  scopePattern: string;
  minTrims: string;
  perIpCooldownMinutes: string;
};

function overridesFromConfig(list: TrimAlertOverride[] | undefined): OverrideDraft[] {
  return (list ?? []).map((o) => ({
    scopePattern: o.scopePattern ?? "",
    minTrims: o.minTrims != null ? String(o.minTrims) : "",
    perIpCooldownMinutes:
      o.perIpCooldownMinutes != null ? String(o.perIpCooldownMinutes) : "",
  }));
}

function draftsToPayload(drafts: OverrideDraft[]): {
  ok: boolean;
  cleaned?: TrimAlertOverride[];
  error?: string;
} {
  const cleaned: TrimAlertOverride[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const scopePattern = d.scopePattern.trim();
    if (!scopePattern) {
      return { ok: false, error: `Override #${i + 1}: pattern is required` };
    }
    const entry: TrimAlertOverride = { scopePattern };
    if (d.minTrims.trim() !== "") {
      const n = Number.parseInt(d.minTrims.trim(), 10);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: `Override #${i + 1}: min trims must be a positive integer` };
      }
      entry.minTrims = n;
    }
    if (d.perIpCooldownMinutes.trim() !== "") {
      const n = Number.parseInt(d.perIpCooldownMinutes.trim(), 10);
      if (!Number.isFinite(n) || n < 0 || n > 10080) {
        return { ok: false, error: `Override #${i + 1}: cooldown must be between 0 and 10080` };
      }
      entry.perIpCooldownMinutes = n;
    }
    if (entry.minTrims === undefined && entry.perIpCooldownMinutes === undefined) {
      return {
        ok: false,
        error: `Override #${i + 1}: set at least one of min trims / cooldown`,
      };
    }
    cleaned.push(entry);
  }
  return { ok: true, cleaned };
}

type TrimAlertHistoryDelivery = {
  id: string;
  createdAt: string;
  status: string;
  channelId: string | null;
  channelName: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  skipReason: string | null;
  triggerSource: string | null;
  scopes: number | null;
  totalTrimmed: number | null;
  cap: number | null;
};

type TrimAlertHistoryResponse = {
  notificationId: string;
  deliveries: TrimAlertHistoryDelivery[];
};

type AuditPruneAnomalyConfigResponse = {
  enabled: boolean;
  minRows: number;
  ratioMultiplier: number;
  baselineWindow: number;
  cooldownMinutes: number;
  defaults: {
    enabled: boolean;
    minRows: number;
    ratioMultiplier: number;
    baselineWindow: number;
    cooldownMinutes: number;
  };
  bounds: {
    minRowsMin: number;
    minRowsMax: number;
    ratioMultiplierMin: number;
    ratioMultiplierMax: number;
    baselineWindowMin: number;
    baselineWindowMax: number;
    cooldownMinutesMin: number;
    cooldownMinutesMax: number;
  };
  lastEdited: LastEdited;
};

function AuditPruneAnomalyAlertSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<AuditPruneAnomalyConfigResponse>({
    queryKey: ["/api/admin/audit-prune-anomaly-config"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit-prune-anomaly-config", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load anomaly-alert config");
      return res.json();
    },
  });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [minRowsDraft, setMinRowsDraft] = useState<string>("");
  const [ratioDraft, setRatioDraft] = useState<string>("");
  const [windowDraft, setWindowDraft] = useState<string>("");
  const [cooldownDraft, setCooldownDraft] = useState<string>("");

  useEffect(() => {
    if (!data) return;
    if (enabled === null) setEnabled(data.enabled);
    if (minRowsDraft === "") setMinRowsDraft(String(data.minRows));
    if (ratioDraft === "") setRatioDraft(String(data.ratioMultiplier));
    if (windowDraft === "") setWindowDraft(String(data.baselineWindow));
    if (cooldownDraft === "") setCooldownDraft(String(data.cooldownMinutes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (patch: {
      enabled: boolean;
      minRows: number;
      ratioMultiplier: number;
      baselineWindow: number;
      cooldownMinutes: number;
    }) => {
      const res = await apiRequest(
        "PUT",
        "/api/admin/audit-prune-anomaly-config",
        patch,
      );
      return (await res.json()) as Pick<
        AuditPruneAnomalyConfigResponse,
        "enabled" | "minRows" | "ratioMultiplier" | "baselineWindow" | "cooldownMinutes"
      >;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/audit-prune-anomaly-config"],
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/audit-retention/history"],
      });
      toast({
        title: "Anomaly-alert settings saved",
        description: "Future prune runs will be checked against the new thresholds.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save anomaly-alert settings",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  if (isLoading || !data || enabled === null) {
    return (
      <div
        className="bg-card rounded-lg border shadow-sm p-6 mb-6"
        data-testid="card-audit-prune-anomaly-loading"
      >
        <div className="text-sm text-muted-foreground">Loading anomaly-alert settings…</div>
      </div>
    );
  }

  const minRowsNum = Number.parseInt(minRowsDraft, 10);
  const ratioNum = Number.parseFloat(ratioDraft);
  const windowNum = Number.parseInt(windowDraft, 10);
  const cooldownNum = Number.parseInt(cooldownDraft, 10);

  const b = data.bounds;
  const minRowsValid =
    Number.isFinite(minRowsNum) &&
    Number.isInteger(minRowsNum) &&
    minRowsNum >= b.minRowsMin &&
    minRowsNum <= b.minRowsMax;
  const ratioValid =
    Number.isFinite(ratioNum) &&
    ratioNum >= b.ratioMultiplierMin &&
    ratioNum <= b.ratioMultiplierMax;
  const windowValid =
    Number.isFinite(windowNum) &&
    Number.isInteger(windowNum) &&
    windowNum >= b.baselineWindowMin &&
    windowNum <= b.baselineWindowMax;
  const cooldownValid =
    Number.isFinite(cooldownNum) &&
    Number.isInteger(cooldownNum) &&
    cooldownNum >= b.cooldownMinutesMin &&
    cooldownNum <= b.cooldownMinutesMax;
  const allValid = minRowsValid && ratioValid && windowValid && cooldownValid;
  const dirty =
    enabled !== data.enabled ||
    (minRowsValid && minRowsNum !== data.minRows) ||
    (ratioValid && ratioNum !== data.ratioMultiplier) ||
    (windowValid && windowNum !== data.baselineWindow) ||
    (cooldownValid && cooldownNum !== data.cooldownMinutes);

  return (
    <div
      className="bg-card rounded-lg border shadow-sm p-6 mb-6"
      data-testid="card-audit-prune-anomaly-config"
    >
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-primary" />
        <h2
          className="text-sm font-semibold text-foreground"
          data-testid="text-audit-prune-anomaly-title"
        >
          Anomaly alert
        </h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Sends a Slack and/or email alert when an audit prune deletes an unusually large
        number of rows. A run is anomalous when it deletes at least the absolute floor
        AND at least the ratio multiplier × the average of recent non-zero runs in the
        baseline window. Per-table cooldown prevents repeated alerts during a single
        incident. Channels are configured in Notification Settings under
        <code className="ml-1">infra.audit_prune.unusually_large_delete</code>.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <input
          type="checkbox"
          id="toggle-anomaly-alert-enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="toggle-anomaly-alert-enabled"
        />
        <label htmlFor="toggle-anomaly-alert-enabled" className="text-sm">
          Send anomaly alerts (master switch)
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="input-anomaly-min-rows"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Absolute floor (rows, {b.minRowsMin}–{b.minRowsMax.toLocaleString()})
          </label>
          <Input
            id="input-anomaly-min-rows"
            type="number"
            inputMode="numeric"
            min={b.minRowsMin}
            max={b.minRowsMax}
            step={1}
            value={minRowsDraft}
            onChange={(e) => setMinRowsDraft(e.target.value)}
            data-testid="input-anomaly-min-rows"
          />
        </div>
        <div>
          <label
            htmlFor="input-anomaly-ratio"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Ratio multiplier (× baseline avg, {b.ratioMultiplierMin}–
            {b.ratioMultiplierMax})
          </label>
          <Input
            id="input-anomaly-ratio"
            type="number"
            inputMode="decimal"
            min={b.ratioMultiplierMin}
            max={b.ratioMultiplierMax}
            step={0.1}
            value={ratioDraft}
            onChange={(e) => setRatioDraft(e.target.value)}
            data-testid="input-anomaly-ratio"
          />
        </div>
        <div>
          <label
            htmlFor="input-anomaly-baseline-window"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Baseline window (events, {b.baselineWindowMin}–{b.baselineWindowMax})
          </label>
          <Input
            id="input-anomaly-baseline-window"
            type="number"
            inputMode="numeric"
            min={b.baselineWindowMin}
            max={b.baselineWindowMax}
            step={1}
            value={windowDraft}
            onChange={(e) => setWindowDraft(e.target.value)}
            data-testid="input-anomaly-baseline-window"
          />
        </div>
        <div>
          <label
            htmlFor="input-anomaly-cooldown"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Per-table cooldown (minutes, {b.cooldownMinutesMin}–
            {b.cooldownMinutesMax})
          </label>
          <Input
            id="input-anomaly-cooldown"
            type="number"
            inputMode="numeric"
            min={b.cooldownMinutesMin}
            max={b.cooldownMinutesMax}
            step={1}
            value={cooldownDraft}
            onChange={(e) => setCooldownDraft(e.target.value)}
            data-testid="input-anomaly-cooldown"
          />
        </div>
      </div>

      {!allValid && (
        <div
          className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mt-3"
          data-testid="status-anomaly-alert-invalid"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>
            One or more values are out of range. Stay within the bounds shown above.
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 mt-4">
        <Button
          disabled={!dirty || !allValid || saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate({
              enabled: !!enabled,
              minRows: minRowsNum,
              ratioMultiplier: ratioNum,
              baselineWindow: windowNum,
              cooldownMinutes: cooldownNum,
            })
          }
          data-testid="button-save-anomaly-alert-config"
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          disabled={saveMutation.isPending}
          onClick={() => {
            setEnabled(data.defaults.enabled);
            setMinRowsDraft(String(data.defaults.minRows));
            setRatioDraft(String(data.defaults.ratioMultiplier));
            setWindowDraft(String(data.defaults.baselineWindow));
            setCooldownDraft(String(data.defaults.cooldownMinutes));
          }}
          data-testid="button-reset-anomaly-alert-config"
        >
          Reset to defaults
        </Button>
      </div>

      <div className="text-xs text-muted-foreground mt-3" data-testid="text-anomaly-alert-last-edited">
        {data.lastEdited?.updatedAt
          ? `Last changed ${new Date(data.lastEdited.updatedAt).toLocaleString()} by ${formatUser(data.lastEdited.updatedBy)}`
          : "No admin edits recorded yet — using defaults or env values."}
      </div>
    </div>
  );
}

function BlockedIpTrimAlertSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<TrimAlertConfigResponse>({
    queryKey: ["/api/admin/blocked-ip-trim-alert-config"],
    queryFn: async () => {
      const res = await fetch("/api/admin/blocked-ip-trim-alert-config", {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load trim-alert config");
      return res.json();
    },
  });

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [emailDraft, setEmailDraft] = useState<string>("");
  const [minTrimsDraft, setMinTrimsDraft] = useState<string>("");
  const [windowDraft, setWindowDraft] = useState<string>("");
  const [cooldownDraft, setCooldownDraft] = useState<string>("");
  const [overridesDraft, setOverridesDraft] = useState<OverrideDraft[] | null>(null);

  useEffect(() => {
    if (!data) return;
    if (enabled === null) setEnabled(data.enabled);
    if (emailDraft === "") setEmailDraft(data.email);
    if (minTrimsDraft === "") setMinTrimsDraft(String(data.minTrims));
    if (windowDraft === "") setWindowDraft(String(data.batchWindowSeconds));
    if (cooldownDraft === "") setCooldownDraft(String(data.perIpCooldownMinutes));
    if (overridesDraft === null) setOverridesDraft(overridesFromConfig(data.overrides));
    // Each draft is seeded only while still at its sentinel value, so
    // re-runs from the draft dependencies below are no-ops once seeded.
  }, [data, enabled, emailDraft, minTrimsDraft, windowDraft, cooldownDraft, overridesDraft]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Partial<TrimAlertConfigResponse>) => {
      const res = await apiRequest(
        "PUT",
        "/api/admin/blocked-ip-trim-alert-config",
        patch,
      );
      return (await res.json()) as TrimAlertConfigResponse;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/admin/blocked-ip-trim-alert-config"], next);
      toast({
        title: "Trim-alert settings saved",
        description: next.enabled
          ? `Alerts on; ${next.emailRecipients.length} email recipient${next.emailRecipients.length === 1 ? "" : "s"}.`
          : "Alerts are off.",
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save trim-alert settings",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/blocked-ip-trim-alert-config/test",
        {},
      );
      return (await res.json()) as {
        result: {
          slack: { delivered: boolean; skipReason?: string } | null;
          email: { delivered: boolean; recipients: number; reason?: string } | null;
        };
      };
    },
    onSuccess: (r) => {
      const slackOk = r.result.slack?.delivered;
      const emailOk = r.result.email?.delivered;
      toast({
        title: "Test alert sent",
        description:
          `Slack: ${slackOk ? "delivered" : `skipped (${r.result.slack?.skipReason ?? "unknown"})`} · ` +
          `Email: ${emailOk ? `sent to ${r.result.email?.recipients}` : `skipped (${r.result.email?.reason ?? "no recipients"})`}`,
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/blocked-ip-trim-alert-history"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Test send failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  const historyQuery = useQuery<TrimAlertHistoryResponse>({
    queryKey: ["/api/admin/blocked-ip-trim-alert-history"],
    queryFn: async () => {
      const res = await fetch(
        "/api/admin/blocked-ip-trim-alert-history?limit=20",
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load trim-alert history");
      return res.json();
    },
  });

  const flushMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/admin/blocked-ip-trim-alert-config/flush",
        {},
      );
      return (await res.json()) as {
        result: {
          pendingScopes: number;
          alertedScopes: number;
          totalTrimmed: number;
          slack: { delivered: boolean; skipReason?: string } | null;
          email: { delivered: boolean; recipients: number; reason?: string } | null;
        };
      };
    },
    onSuccess: (r) => {
      toast({
        title:
          r.result.alertedScopes > 0
            ? "Pending trim alerts flushed"
            : "Nothing pending to flush",
        description:
          r.result.alertedScopes > 0
            ? `Alerted ${r.result.alertedScopes} scope${r.result.alertedScopes === 1 ? "" : "s"} (${r.result.totalTrimmed} row${r.result.totalTrimmed === 1 ? "" : "s"} trimmed).`
            : `Pending scopes: ${r.result.pendingScopes}. No new alerts dispatched.`,
      });
      void queryClient.invalidateQueries({ // fire-and-forget: cache refresh only
        queryKey: ["/api/admin/blocked-ip-trim-alert-history"],
      });
    },
    onError: (err: any) => {
      toast({
        title: "Flush failed",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  return (
    <div
      className="bg-card rounded-lg border shadow-sm p-6 mb-6"
      data-testid="card-blocked-ip-trim-alerts"
    >
      <div className="flex items-center gap-2 mb-1">
        <AlertTriangle className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          Out-of-band trim notifications
        </h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Send a Slack message and/or email when the per-IP cap auto-trims older
        blocked-IP history rows. Notifications are batched per window with a
        per-IP cooldown so a noisy IP cannot flood admins. Slack channel is
        configured in Notification Settings.
      </p>
      {isLoading || !data || enabled === null ? (
        <div className="text-sm text-muted-foreground" data-testid="text-trim-alerts-loading">
          Loading…
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <input
              type="checkbox"
              id="toggle-trim-alerts-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              data-testid="toggle-trim-alerts-enabled"
            />
            <label htmlFor="toggle-trim-alerts-enabled" className="text-sm">
              Send trim notifications (master switch)
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label
                htmlFor="input-trim-alert-email"
                className="block text-sm font-medium text-foreground mb-1"
              >
                Email recipients (comma-separated; blank = no email)
              </label>
              <Input
                id="input-trim-alert-email"
                type="text"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="alerts@example.com, admin@example.com"
                data-testid="input-trim-alert-email"
              />
            </div>
            <div>
              <label
                htmlFor="input-trim-alert-min"
                className="block text-sm font-medium text-foreground mb-1"
              >
                Min trims per IP before alerting
              </label>
              <Input
                id="input-trim-alert-min"
                type="number"
                min={1}
                value={minTrimsDraft}
                onChange={(e) => setMinTrimsDraft(e.target.value)}
                data-testid="input-trim-alert-min"
              />
            </div>
            <div>
              <label
                htmlFor="input-trim-alert-window"
                className="block text-sm font-medium text-foreground mb-1"
              >
                Batch window (seconds, 5–3600)
              </label>
              <Input
                id="input-trim-alert-window"
                type="number"
                min={5}
                max={3600}
                value={windowDraft}
                onChange={(e) => setWindowDraft(e.target.value)}
                data-testid="input-trim-alert-window"
              />
            </div>
            <div>
              <label
                htmlFor="input-trim-alert-cooldown"
                className="block text-sm font-medium text-foreground mb-1"
              >
                Per-IP cooldown (minutes, 1–10080)
              </label>
              <Input
                id="input-trim-alert-cooldown"
                type="number"
                min={1}
                max={10080}
                value={cooldownDraft}
                onChange={(e) => setCooldownDraft(e.target.value)}
                data-testid="input-trim-alert-cooldown"
              />
            </div>
          </div>

          <div className="mt-6 border-t pt-4" data-testid="section-trim-alert-overrides">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-foreground">
                Per-IP-prefix overrides
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverridesDraft([
                    ...(overridesDraft ?? []),
                    { scopePattern: "", minTrims: "", perIpCooldownMinutes: "" },
                  ])
                }
                data-testid="button-add-trim-alert-override"
              >
                Add override
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              First matching pattern wins. Supports exact scope (
              <code>ip:1.2.3.4</code>), glob with <code>*</code> (
              <code>ip:1.2.3.*</code>), or IPv4 CIDR (
              <code>203.0.113.0/24</code>). Leave a field blank to inherit the
              global value above.
            </p>
            {(overridesDraft ?? []).length === 0 ? (
              <div
                className="text-xs text-muted-foreground italic"
                data-testid="text-trim-alert-overrides-empty"
              >
                No overrides — all IPs use the global thresholds above.
              </div>
            ) : (
              <div className="space-y-2">
                {(overridesDraft ?? []).map((o, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-start border rounded p-2 bg-muted/50"
                    data-testid={`row-trim-alert-override-${idx}`}
                  >
                    <div className="sm:col-span-6">
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Scope pattern
                      </label>
                      <Input
                        type="text"
                        value={o.scopePattern}
                        onChange={(e) => {
                          const next = [...(overridesDraft ?? [])];
                          next[idx] = { ...next[idx], scopePattern: e.target.value };
                          setOverridesDraft(next);
                        }}
                        placeholder="ip:203.0.113.* or 203.0.113.0/24"
                        data-testid={`input-trim-alert-override-pattern-${idx}`}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Min trims
                      </label>
                      <Input
                        type="number"
                        min={1}
                        value={o.minTrims}
                        onChange={(e) => {
                          const next = [...(overridesDraft ?? [])];
                          next[idx] = { ...next[idx], minTrims: e.target.value };
                          setOverridesDraft(next);
                        }}
                        placeholder="inherit"
                        data-testid={`input-trim-alert-override-min-${idx}`}
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Cooldown (min)
                      </label>
                      <Input
                        type="number"
                        min={0}
                        max={10080}
                        value={o.perIpCooldownMinutes}
                        onChange={(e) => {
                          const next = [...(overridesDraft ?? [])];
                          next[idx] = {
                            ...next[idx],
                            perIpCooldownMinutes: e.target.value,
                          };
                          setOverridesDraft(next);
                        }}
                        placeholder="inherit"
                        data-testid={`input-trim-alert-override-cooldown-${idx}`}
                      />
                    </div>
                    <div className="sm:col-span-1 flex sm:justify-end sm:pt-6">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          const next = [...(overridesDraft ?? [])];
                          next.splice(idx, 1);
                          setOverridesDraft(next);
                        }}
                        data-testid={`button-remove-trim-alert-override-${idx}`}
                        aria-label="Remove override"
                      >
                        <Trash2 className="w-4 h-4 text-red-600" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 mt-4">
            <Button
              disabled={saveMutation.isPending}
              onClick={() => {
                const payload = draftsToPayload(overridesDraft ?? []);
                if (!payload.ok) {
                  toast({
                    title: "Override validation failed",
                    description: payload.error,
                    variant: "destructive",
                  });
                  return;
                }
                saveMutation.mutate({
                  enabled: !!enabled,
                  email: emailDraft,
                  minTrims: Number.parseInt(minTrimsDraft, 10) || data.minTrims,
                  batchWindowSeconds:
                    Number.parseInt(windowDraft, 10) || data.batchWindowSeconds,
                  perIpCooldownMinutes:
                    Number.parseInt(cooldownDraft, 10) || data.perIpCooldownMinutes,
                  overrides: payload.cleaned,
                });
              }}
              data-testid="button-save-trim-alert-config"
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              disabled={testMutation.isPending}
              onClick={() => testMutation.mutate()}
              data-testid="button-send-trim-alert-test"
              title="Send a synthetic test alert through both channels (works even while alerts are disabled)"
            >
              {testMutation.isPending ? "Sending…" : "Send test"}
            </Button>
            <Button
              variant="outline"
              disabled={flushMutation.isPending}
              onClick={() => flushMutation.mutate()}
              data-testid="button-flush-trim-alerts"
              title="Force the next batch of pending trim events to dispatch now instead of waiting for the batch-window timer."
            >
              {flushMutation.isPending ? "Flushing…" : "Flush pending now"}
            </Button>
          </div>

          <div
            className="mt-6 rounded-md border p-3 space-y-2"
            data-testid="card-trim-alert-history"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-foreground">
                Recent trim alerts
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  queryClient.invalidateQueries({
                    queryKey: ["/api/admin/blocked-ip-trim-alert-history"],
                  })
                }
                data-testid="button-refresh-trim-alert-history"
              >
                Refresh
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Pulled from the canonical notification-deliveries log for{" "}
              <code>usage.blocked_ip_audit.trimmed</code>. Shows the last 20
              dispatches with their delivery status and skip reason.
            </p>
            {historyQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : historyQuery.isError ? (
              <p
                className="text-xs text-red-700"
                data-testid="text-trim-alert-history-error"
              >
                Failed to load trim-alert history:{" "}
                {String(
                  (historyQuery.error as any)?.message ??
                    historyQuery.error ??
                    "unknown error",
                )}
              </p>
            ) : historyQuery.data && historyQuery.data.deliveries.length > 0 ? (
              <div className="overflow-x-auto">
                <table
                  className="w-full text-xs border-collapse"
                  data-testid="table-trim-alert-history"
                >
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2">When</th>
                      <th className="py-1 pr-2">Channel</th>
                      <th className="py-1 pr-2">Status</th>
                      <th className="py-1 pr-2">Trigger</th>
                      <th className="py-1 pr-2">Scopes</th>
                      <th className="py-1 pr-2">Trimmed</th>
                      <th className="py-1 pr-2">Reason / error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyQuery.data.deliveries.map((d) => {
                      const isSuccess = d.status === "success";
                      const isFailure = d.status === "failed";
                      const statusClass = isSuccess
                        ? "text-emerald-700"
                        : isFailure
                          ? "text-red-700"
                          : "text-amber-700";
                      const reason =
                        d.errorMessage ||
                        d.skipReason ||
                        d.errorCode ||
                        (isSuccess ? "" : d.status);
                      return (
                        <tr
                          key={d.id}
                          className="border-t"
                          data-testid={`row-trim-alert-history-${d.id}`}
                        >
                          <td className="py-1 pr-2 text-muted-foreground whitespace-nowrap">
                            {new Date(d.createdAt).toLocaleString()}
                          </td>
                          <td className="py-1 pr-2 font-mono text-muted-foreground">
                            {d.channelName || d.channelId || "—"}
                          </td>
                          <td
                            className={`py-1 pr-2 font-mono ${statusClass}`}
                            data-testid={`text-trim-alert-history-status-${d.id}`}
                          >
                            {d.status}
                          </td>
                          <td className="py-1 pr-2 text-muted-foreground">
                            {d.triggerSource ?? "—"}
                          </td>
                          <td className="py-1 pr-2 text-muted-foreground">
                            {d.scopes ?? "—"}
                          </td>
                          <td className="py-1 pr-2 text-muted-foreground">
                            {d.totalTrimmed ?? "—"}
                          </td>
                          <td
                            className="py-1 pr-2 text-muted-foreground"
                            title={reason || ""}
                          >
                            {reason || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-trim-alert-history-empty"
              >
                No trim alerts dispatched yet.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ClientContactsAuditRetentionSection() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<ClientContactsAuditRetentionResponse>({
    queryKey: ["/api/admin/client-contacts-audit-retention"],
    queryFn: async () => {
      const res = await fetch("/api/admin/client-contacts-audit-retention", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load client_contacts retention");
      return res.json();
    },
  });

  const [daysDraft, setDaysDraft] = useState<string>("");
  const [minDraft, setMinDraft] = useState<string>("");
  const [confirmShortenOpen, setConfirmShortenOpen] = useState(false);
  // Task #4357: manual prune deletes rows immediately — confirm first, same
  // as the sibling "Run prune now" flow for the other audit tables.
  const [confirmClientPruneOpen, setConfirmClientPruneOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    if (daysDraft === "") setDaysDraft(String(data.retentionDays));
    if (minDraft === "") setMinDraft(String(data.minPerContact));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (patch: { retentionDays?: number; minPerContact?: number }) => {
      const res = await apiRequest("PUT", "/api/admin/client-contacts-audit-retention", patch);
      // The PUT response intentionally omits the stats block (it's a partial
      // update payload). Refetch the canonical GET shape via invalidation
      // below rather than writing this partial into the cache.
      return (await res.json()) as { retentionDays: number; minPerContact: number };
    },
    onSuccess: (next) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/client-contacts-audit-retention"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/prune-events"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Contact-history retention updated",
        description: `Now keeping the last ${next.retentionDays} day${next.retentionDays === 1 ? "" : "s"}, plus the latest ${next.minPerContact} edit${next.minPerContact === 1 ? "" : "s"} per contact.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not update contact-history retention",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  const pruneMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/client-contacts-audit-retention/prune-now", {});
      return (await res.json()) as { result: { deleted: number; retentionDays: number; minPerContact: number } };
    },
    onSuccess: (next) => {
      toast({
        title: "Contact-history prune complete",
        description: `Removed ${next.result.deleted.toLocaleString()} row${next.result.deleted === 1 ? "" : "s"} (kept last ${next.result.minPerContact} per contact, ${next.result.retentionDays}-day window).`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/client-contacts-audit-retention"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/prune-events"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Could not run contact-history prune",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  if (isLoading || !data) {
    return (
      <div
        className="bg-card rounded-lg border shadow-sm p-6 mb-6"
        data-testid="card-client-contacts-retention-loading"
      >
        <div className="text-sm text-muted-foreground">Loading contact-history retention…</div>
      </div>
    );
  }

  const daysNum = Number.parseInt(daysDraft, 10);
  const minNum = Number.parseInt(minDraft, 10);
  const daysValid =
    Number.isFinite(daysNum) && Number.isInteger(daysNum) && daysNum >= data.minDays && daysNum <= data.maxDays;
  const minValid =
    Number.isFinite(minNum) && Number.isInteger(minNum) && minNum >= data.minPerContactMin && minNum <= data.minPerContactMax;
  const daysDirty = daysValid && daysNum !== data.retentionDays;
  const minDirty = minValid && minNum !== data.minPerContact;
  const dirty = daysDirty || minDirty;
  const isShortening = daysDirty && daysNum < data.retentionDays;

  const onSaveClick = () => {
    if (!dirty) return;
    if (isShortening) {
      setConfirmShortenOpen(true);
    } else {
      saveMutation.mutate({
        retentionDays: daysDirty ? daysNum : undefined,
        minPerContact: minDirty ? minNum : undefined,
      });
    }
  };

  return (
    <div
      className="bg-card rounded-lg border shadow-sm p-6 mb-6"
      data-testid="card-client-contacts-retention"
    >
      <div className="flex items-center gap-2 mb-1">
        <Archive className="w-4 h-4 text-primary" />
        <h2
          className="text-sm font-semibold text-foreground"
          data-testid="text-client-contacts-retention-title"
        >
          Contact edit-history retention
        </h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Controls how long the per-contact edit history shown in the Command Panel
        and CRM dialogs is kept. Older rows are pruned by the same daily job as
        the other audit tables, but every contact always retains at least the
        configured floor of most-recent rows.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-3">
        <div>
          <label
            htmlFor="input-client-contacts-retention-days"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Retention window (days)
          </label>
          <Input
            id="input-client-contacts-retention-days"
            type="number"
            inputMode="numeric"
            min={data.minDays}
            max={data.maxDays}
            step={1}
            value={daysDraft}
            onChange={(e) => setDaysDraft(e.target.value)}
            data-testid="input-client-contacts-retention-days"
          />
          <div className="text-xs text-muted-foreground mt-1">
            Allowed range: {data.minDays}–{data.maxDays} days.
          </div>
        </div>
        <div>
          <label
            htmlFor="input-client-contacts-min-per-contact"
            className="block text-sm font-medium text-foreground mb-1"
          >
            Minimum rows kept per contact
          </label>
          <Input
            id="input-client-contacts-min-per-contact"
            type="number"
            inputMode="numeric"
            min={data.minPerContactMin}
            max={data.minPerContactMax}
            step={1}
            value={minDraft}
            onChange={(e) => setMinDraft(e.target.value)}
            data-testid="input-client-contacts-min-per-contact"
          />
          <div className="text-xs text-muted-foreground mt-1">
            Allowed range: {data.minPerContactMin}–{data.minPerContactMax} rows.
          </div>
        </div>
      </div>

      {(!daysValid && daysDraft !== "") || (!minValid && minDraft !== "") ? (
        <div
          className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3"
          data-testid="status-client-contacts-invalid"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>Enter whole numbers within the allowed ranges above.</span>
        </div>
      ) : null}

      {isShortening && (
        <div
          className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-3"
          data-testid="status-client-contacts-shortening"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>
            Shortening retention from {data.retentionDays} to {daysNum} days.
            Saving will immediately delete contact-audit rows older than {daysNum} days
            (beyond the latest {minDirty ? minNum : data.minPerContact} per contact).
          </span>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <Button
          disabled={!dirty || saveMutation.isPending}
          onClick={onSaveClick}
          data-testid="button-save-client-contacts-retention"
        >
          {saveMutation.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          disabled={
            saveMutation.isPending ||
            (daysDraft === String(data.retentionDays) && minDraft === String(data.minPerContact))
          }
          onClick={() => {
            setDaysDraft(String(data.retentionDays));
            setMinDraft(String(data.minPerContact));
          }}
          data-testid="button-reset-client-contacts-retention"
        >
          Reset
        </Button>
        <Button
          variant="outline"
          onClick={() => setConfirmClientPruneOpen(true)}
          disabled={pruneMutation.isPending}
          data-testid="button-prune-client-contacts-now"
        >
          {pruneMutation.isPending ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Pruning…
            </>
          ) : (
            <>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Prune contact history now
            </>
          )}
        </Button>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">Currently keeping</dt>
          <dd className="font-medium text-foreground" data-testid="text-client-contacts-current">
            Last {data.retentionDays} day{data.retentionDays === 1 ? "" : "s"}, plus latest {data.minPerContact} per contact
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="font-medium text-foreground" data-testid="text-client-contacts-source">
            {data.retentionDaysSource === "setting" ? "Saved by an admin" : data.retentionDaysSource === "env" ? "Inherited from env" : `Built-in default (${data.defaultRetentionDays}d / ${data.defaultMinPerContact})`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Total rows</dt>
          <dd className="font-medium text-foreground" data-testid="text-client-contacts-total">
            {data.stats.totalRows.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Oldest row</dt>
          <dd className="font-medium text-foreground" data-testid="text-client-contacts-oldest">
            {formatOldest(data.stats.oldestCreatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Would prune at current settings</dt>
          <dd
            className={`font-medium ${data.stats.rowsOlderThanRetention > 0 ? "text-amber-700" : "text-foreground"}`}
            data-testid="text-client-contacts-would-prune"
          >
            {data.stats.rowsOlderThanRetention.toLocaleString()} row{data.stats.rowsOlderThanRetention === 1 ? "" : "s"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Contacts with rows beyond floor</dt>
          <dd className="font-medium text-foreground" data-testid="text-client-contacts-floor">
            {data.stats.contactsWithFloorRows.toLocaleString()}
          </dd>
        </div>
      </dl>

      <AlertDialog open={confirmClientPruneOpen} onOpenChange={setConfirmClientPruneOpen}>
        <AlertDialogContent data-testid="dialog-confirm-prune-client-contacts">
          <AlertDialogHeader>
            <AlertDialogTitle>Prune contact edit history now?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately deletes client_contacts_audit rows older than the
              current {data.retentionDays}-day window, keeping at least the newest{" "}
              {data.minPerContact} per contact. The daily job would do the same
              tonight. Deleted rows cannot be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-prune-client-contacts">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-prune-client-contacts"
              onClick={() => {
                setConfirmClientPruneOpen(false);
                pruneMutation.mutate();
              }}
            >
              Run prune
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmShortenOpen} onOpenChange={setConfirmShortenOpen}>
        <AlertDialogContent data-testid="dialog-confirm-shorten-client-contacts">
          <AlertDialogHeader>
            <AlertDialogTitle>Shorten contact-history retention?</AlertDialogTitle>
            <AlertDialogDescription>
              Saving will immediately delete client_contacts_audit rows older than {daysNum} day
              {daysNum === 1 ? "" : "s"} (down from {data.retentionDays}), beyond the latest{" "}
              {minDirty ? minNum : data.minPerContact} per contact. Deleted rows cannot be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-shorten-client-contacts">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-shorten-client-contacts"
              onClick={() => {
                setConfirmShortenOpen(false);
                saveMutation.mutate({
                  retentionDays: daysDirty ? daysNum : undefined,
                  minPerContact: minDirty ? minNum : undefined,
                });
              }}
            >
              Shorten and prune
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const SHORTEN_WIPE_THRESHOLD_PCT = 50;
const TYPED_CONFIRM_PHRASE = "DELETE";

function ShortenAuditDialog({
  open,
  onOpenChange,
  draftNum,
  currentDays,
  stats,
  statsLoading,
  previewDaysParam,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draftNum: number;
  currentDays: number | null;
  stats: AuditRetentionStatsResponse | null;
  statsLoading: boolean;
  previewDaysParam: number | null;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [ackUnavailable, setAckUnavailable] = useState(false);

  useEffect(() => {
    if (!open) {
      setTyped("");
      setAckUnavailable(false);
    }
  }, [open]);

  const rows: Array<{ key: string; label: string; s: AuditTableStats }> = stats
    ? [
        { key: "admin", label: "admin_setting_audit", s: stats.adminSettingAudit },
        { key: "stale", label: "stale_lease_threshold_audit", s: stats.staleLeaseThresholdAudit },
        { key: "queue", label: "queue_timing_audit", s: stats.queueTimingAudit },
      ]
    : [];

  const previewMatchesDraft =
    previewDaysParam === draftNum &&
    (stats?.previewDays === null || stats?.previewDays === draftNum);
  const usable = !!stats && previewMatchesDraft && !statsLoading;

  const totalRows = rows.reduce((acc, r) => acc + r.s.totalRows, 0);
  const totalPrune = rows.reduce((acc, r) => acc + r.s.rowsOlderThanRetention, 0);
  const maxPct = rows.reduce((acc, r) => {
    const pct = r.s.totalRows > 0 ? (r.s.rowsOlderThanRetention / r.s.totalRows) * 100 : 0;
    return Math.max(acc, pct);
  }, 0);
  const requiresTyped = usable && maxPct > SHORTEN_WIPE_THRESHOLD_PCT;
  const typedOk = !requiresTyped || typed.trim().toUpperCase() === TYPED_CONFIRM_PHRASE;
  const canConfirm = usable ? typedOk : ackUnavailable;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="dialog-confirm-shorten-retention">
        <AlertDialogHeader>
          <AlertDialogTitle>Shorten audit retention?</AlertDialogTitle>
          <AlertDialogDescription data-testid="text-confirm-shorten-warning">
            This will immediately delete audit rows older than {draftNum} day{draftNum === 1 ? "" : "s"}
            {currentDays !== null ? ` (down from ${currentDays})` : ""}. Deleted rows cannot be recovered.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-sm" data-testid="section-shorten-impact">
          {statsLoading && !stats ? (
            <div className="text-muted-foreground" data-testid="text-shorten-impact-loading">Loading impact preview…</div>
          ) : !usable ? (
            <div
              className="border border-amber-200 bg-amber-50 rounded p-2"
              data-testid="section-shorten-impact-unavailable"
            >
              <div className="flex items-start gap-2 text-xs text-amber-800 mb-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span data-testid="text-shorten-impact-unavailable">
                  Impact preview unavailable — we can't confirm how many rows
                  this would delete. Saving will still immediately prune rows
                  older than {draftNum} day{draftNum === 1 ? "" : "s"}.
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs text-amber-900">
                <input
                  type="checkbox"
                  checked={ackUnavailable}
                  onChange={(e) => setAckUnavailable(e.target.checked)}
                  data-testid="checkbox-ack-impact-unavailable"
                />
                <span>I understand the impact preview is unavailable and want to proceed.</span>
              </label>
            </div>
          ) : (
            <>
              <div className="text-xs font-semibold text-foreground mb-1">
                Would-prune row counts at {draftNum}d:
              </div>
              <ul className="divide-y border rounded">
                {rows.map((r) => {
                  const pct = r.s.totalRows > 0 ? (r.s.rowsOlderThanRetention / r.s.totalRows) * 100 : 0;
                  const heavy = pct > SHORTEN_WIPE_THRESHOLD_PCT;
                  return (
                    <li
                      key={r.key}
                      className="flex items-center justify-between px-2 py-1.5 text-xs"
                      data-testid={`row-shorten-impact-${r.key}`}
                    >
                      <span className="font-mono text-foreground">{r.label}</span>
                      <span
                        className={`tabular-nums ${heavy ? "text-red-700 font-semibold" : "text-foreground"}`}
                        data-testid={`text-shorten-impact-${r.key}`}
                      >
                        {r.s.rowsOlderThanRetention.toLocaleString()} / {r.s.totalRows.toLocaleString()}
                        {r.s.totalRows > 0 ? ` (${pct.toFixed(0)}%)` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-2 text-xs text-muted-foreground" data-testid="text-shorten-impact-total">
                Total: {totalPrune.toLocaleString()} of {totalRows.toLocaleString()} row{totalRows === 1 ? "" : "s"} would be deleted.
              </div>
              {requiresTyped && (
                <div
                  className="mt-3 border border-red-200 bg-red-50 rounded p-2"
                  data-testid="section-shorten-typed-confirm"
                >
                  <div className="flex items-start gap-2 text-xs text-red-800 mb-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>
                      This change would delete more than {SHORTEN_WIPE_THRESHOLD_PCT}% of at least one audit table
                      (max {maxPct.toFixed(0)}%). Type <span className="font-mono font-semibold">{TYPED_CONFIRM_PHRASE}</span> to confirm.
                    </span>
                  </div>
                  <Input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder={TYPED_CONFIRM_PHRASE}
                    data-testid="input-shorten-typed-confirm"
                  />
                </div>
              )}
            </>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-shorten">Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="button-confirm-shorten"
            disabled={!canConfirm}
            onClick={(e) => {
              if (!canConfirm) {
                e.preventDefault();
                return;
              }
              onConfirm();
            }}
          >
            Shorten and prune
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AuditRetentionSection() {
  const { user, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [confirmSaveOpen, setConfirmSaveOpen] = useState(false);
  const [confirmPruneOpen, setConfirmPruneOpen] = useState(false);
  const [drillEntryId, setDrillEntryId] = useState<string | null>(null);
  const [drillSweep, setDrillSweep] = useState<{ event: PruneEvent; table: string } | null>(null);
  const [pruneManualOnly, setPruneManualOnly] = useState(false);
  const [showSettingKeyBreakdown, setShowSettingKeyBreakdown] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "retention" | "ipCap" | "manualPrune">(() => {
    if (typeof window === "undefined") return "all";
    const saved = window.sessionStorage.getItem("auditRetention.historyFilter");
    if (
      saved === "retention" ||
      saved === "ipCap" ||
      saved === "manualPrune" ||
      saved === "all"
    )
      return saved;
    return "all";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem("auditRetention.historyFilter", historyFilter);
  }, [historyFilter]);
  const [ipDraft, setIpDraft] = useState<string>("");
  const [confirmLowerIpCapOpen, setConfirmLowerIpCapOpen] = useState(false);

  const { data, isLoading, error } = useQuery<RetentionResponse>({
    queryKey: ["/api/admin/audit-retention"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit-retention", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });

  useEffect(() => {
    if (data && draft === "") {
      setDraft(String(data.retentionDays));
    }
    // Seeds only while `draft` is empty, so the extra dep is a no-op after.
  }, [data, draft]);

  const { data: ipData } = useQuery<BlockedIpAuditRetentionResponse>({
    queryKey: ["/api/admin/blocked-ip-audit-retention"],
    queryFn: async () => {
      const res = await fetch("/api/admin/blocked-ip-audit-retention", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load blocked-IP audit cap");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });

  useEffect(() => {
    if (ipData && ipDraft === "") {
      setIpDraft(String(ipData.maxEntriesPerIp));
    }
    // Seeds only while `ipDraft` is empty, so the extra dep is a no-op after.
  }, [ipData, ipDraft]);

  const ipSaveMutation = useMutation({
    mutationFn: async (maxEntriesPerIp: number) => {
      const res = await apiRequest("PUT", "/api/admin/blocked-ip-audit-retention", {
        maxEntriesPerIp,
      });
      return (await res.json()) as BlockedIpAuditRetentionResponse;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/admin/blocked-ip-audit-retention"], next);
      void queryClient.invalidateQueries({ queryKey: ["/api/health/blocked-ips/trim-notifications"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/history"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/prune-events"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Blocked-IP history cap updated",
        description: `Now keeping the last ${next.maxEntriesPerIp} change${next.maxEntriesPerIp === 1 ? "" : "s"} per IP.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not update blocked-IP history cap",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  const { data: historyData } = useQuery<HistoryResponse>({
    queryKey: ["/api/admin/audit-retention/history"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit-retention/history?limit=25", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load history");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
  });

  const previewDaysParam =
    data && draftValidForPreview(draft, data.minDays, data.maxDays) &&
    Number.parseInt(draft, 10) !== data.retentionDays
      ? Number.parseInt(draft, 10)
      : null;

  const { data: statsData, isLoading: statsLoading } = useQuery<AuditRetentionStatsResponse>({
    queryKey: ["/api/admin/audit-retention/stats", previewDaysParam],
    queryFn: async () => {
      const url = previewDaysParam !== null
        ? `/api/admin/audit-retention/stats?previewDays=${previewDaysParam}`
        : "/api/admin/audit-retention/stats";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load audit stats");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
    refetchInterval: 60_000,
  });

  const { data: pruneEventsData } = useQuery<PruneEventsResponse>({
    queryKey: ["/api/admin/audit-retention/prune-events"],
    queryFn: async () => {
      const res = await fetch("/api/admin/audit-retention/prune-events?limit=20", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load prune events");
      return res.json();
    },
    enabled: !!user && (user.role === "ceo" || user.role === "team_lead"),
    refetchInterval: 30_000,
  });

  const { data: drillData, isLoading: drillLoading } = useQuery<{ entry: AuditEntry }>({
    queryKey: ["/api/admin/audit-retention/audit", drillEntryId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/audit-retention/audit/${drillEntryId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load audit row");
      return res.json();
    },
    enabled: !!drillEntryId,
  });

  const saveMutation = useMutation({
    mutationFn: async (retentionDays: number) => {
      const res = await apiRequest("PUT", "/api/admin/audit-retention", { retentionDays });
      return (await res.json()) as RetentionResponse;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/admin/audit-retention"], next);
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/history"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/prune-events"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/stats"] }); // fire-and-forget: cache refresh only
      toast({
        title: "Audit retention updated",
        description: `Now keeping the last ${next.retentionDays} day${next.retentionDays === 1 ? "" : "s"} of audit history.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Could not update audit retention",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  const pruneMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/audit-retention/prune-now", {});
      return (await res.json()) as PruneNowResponse;
    },
    onSuccess: (next) => {
      const {
        adminSettingAuditDeleted,
        staleLeaseThresholdAuditDeleted,
        queueTimingAuditDeleted,
        blockedIpAuditDeleted,
        clientContactsAuditDeleted,
      } = next.result;
      const blocked = blockedIpAuditDeleted ?? 0;
      const cc = clientContactsAuditDeleted ?? 0;
      const total =
        adminSettingAuditDeleted +
        staleLeaseThresholdAuditDeleted +
        queueTimingAuditDeleted +
        blocked +
        cc;
      toast({
        title: "Audit prune complete",
        description:
          `Removed ${total.toLocaleString()} row${total === 1 ? "" : "s"} ` +
          `(admin=${adminSettingAuditDeleted}, stale-lease=${staleLeaseThresholdAuditDeleted}, ` +
          `queue-timing=${queueTimingAuditDeleted}, blocked-ip=${blocked}, contacts=${cc}).`,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/prune-events"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-retention/stats"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/client-contacts-audit-retention"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Could not run audit prune",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    },
    meta: { silent: true },
  });

  if (authLoading) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user || (user.role !== "ceo" && user.role !== "team_lead")) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] flex flex-col items-center justify-center gap-4">
        <h1 className="text-2xl font-bold text-red-600" data-testid="text-access-denied">Access Denied</h1>
        <p className="text-muted-foreground">Admin access required</p>
        <Link href="/">
          <Button variant="outline" data-testid="button-back-dashboard">
            <ArrowLeft className="w-4 h-4 mr-2" /> Back to Dashboard
          </Button>
        </Link>
      </div>
    );
  }

  const draftNum = Number.parseInt(draft, 10);
  const min = data?.minDays ?? 1;
  const max = data?.maxDays ?? 3650;
  const draftValid = Number.isFinite(draftNum) && Number.isInteger(draftNum) && draftNum >= min && draftNum <= max;
  const dirty = data ? draftValid && draftNum !== data.retentionDays : false;
  const isReducing = data ? draftValid && draftNum < data.retentionDays : false;

  const onSaveClick = () => {
    if (!data || !draftValid) return;
    if (isReducing) {
      setConfirmSaveOpen(true);
    } else {
      saveMutation.mutate(draftNum);
    }
  };

  return (
    <div data-testid="section-audit-retention">
      <div>
        <p className="text-muted-foreground mb-6" data-testid="text-description">
          Choose how many days of admin-setting, stale-lease threshold, and queue-timing audit history to keep.
          Older rows are pruned by a daily job (at 3:30am ET) and immediately after you save a change here.
        </p>

        {isLoading && (
          <div className="flex items-center justify-center py-12" data-testid="status-loading">
            <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 mb-4" data-testid="status-error">
            Failed to load audit retention setting.
          </div>
        )}

        {data && (
          <>
            <div className="bg-card rounded-lg border shadow-sm p-6 mb-6">
              <div className="flex flex-wrap items-end gap-3 mb-3">
                <div className="flex-1 min-w-0">
                  <label htmlFor="input-retention-days" className="block text-sm font-medium text-foreground mb-1">
                    Retention window (days)
                  </label>
                  <Input
                    id="input-retention-days"
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    step={1}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    data-testid="input-retention-days"
                  />
                </div>
                <Button
                  disabled={!dirty || saveMutation.isPending}
                  onClick={onSaveClick}
                  data-testid="button-save-retention"
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </Button>
                <Button
                  variant="outline"
                  disabled={saveMutation.isPending || draft === String(data.retentionDays)}
                  onClick={() => setDraft(String(data.retentionDays))}
                  data-testid="button-reset-draft"
                >
                  Reset
                </Button>
              </div>

              <div className="text-xs text-muted-foreground mb-4" data-testid="text-retention-bounds">
                Allowed range: {min}–{max} days.
              </div>

              {!draftValid && draft !== "" && (
                <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-4" data-testid="status-invalid">
                  <AlertTriangle className="w-4 h-4 mt-0.5" />
                  <span>Enter a whole number between {min} and {max}.</span>
                </div>
              )}

              {dirty && isReducing && (
                <div className="flex items-start gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-4" data-testid="status-reducing-warning">
                  <AlertTriangle className="w-4 h-4 mt-0.5" />
                  <span>
                    You're shortening retention from {data.retentionDays} to {draftNum} days.
                    Saving will immediately delete audit rows older than {draftNum} days.
                  </span>
                </div>
              )}

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div>
                  <dt className="text-muted-foreground">Currently keeping</dt>
                  <dd className="font-medium text-foreground" data-testid="text-current-retention">
                    {data.retentionDays} days
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Source</dt>
                  <dd className="font-medium text-foreground" data-testid="text-retention-source">
                    {describeSource(data.source, data.envDays, data.defaultDays)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last changed</dt>
                  <dd className="font-medium text-foreground" data-testid="text-last-changed-at">
                    {data.lastEdited?.updatedAt
                      ? new Date(data.lastEdited.updatedAt).toLocaleString()
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Changed by</dt>
                  <dd className="font-medium text-foreground" data-testid="text-last-changed-by">
                    {formatUser(data.lastEdited?.updatedBy ?? null)}
                  </dd>
                </div>
              </dl>
            </div>

            <div
              className="bg-card rounded-lg border shadow-sm p-6 mb-6"
              data-testid="card-audit-stats"
            >
              <div className="flex items-center gap-2 mb-3">
                <Database className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-foreground">
                  Current audit row counts
                </h2>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Live totals for the tables this retention setting controls.
                {previewDaysParam !== null
                  ? ` Showing what would be removed if you saved ${previewDaysParam} day${previewDaysParam === 1 ? "" : "s"} (vs. the current ${data.retentionDays}).`
                  : ` "Older than retention" shows what the next prune will remove at the current ${data.retentionDays}-day window.`}
              </p>
              {statsLoading && !statsData ? (
                <div className="text-sm text-muted-foreground" data-testid="text-stats-loading">
                  Loading row counts…
                </div>
              ) : !statsData ? (
                <div className="text-sm text-muted-foreground" data-testid="text-stats-empty">
                  No stats available.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-audit-stats">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-2 pr-3 font-medium">Table</th>
                        <th className="py-2 pr-3 font-medium text-right">Total rows</th>
                        <th className="py-2 pr-3 font-medium">Oldest row</th>
                        <th className="py-2 pr-3 font-medium text-right">
                          {previewDaysParam !== null
                            ? `Would prune at ${previewDaysParam}d`
                            : `Older than ${data.retentionDays}d`}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {([
                        { key: "admin", label: "admin_setting_audit", s: statsData.adminSettingAudit },
                        { key: "stale", label: "stale_lease_threshold_audit", s: statsData.staleLeaseThresholdAudit },
                        { key: "queue", label: "queue_timing_audit", s: statsData.queueTimingAudit },
                      ] as const).map((row) => (
                        <tr key={row.key} data-testid={`row-stats-${row.key}`}>
                          <td className="py-2 pr-3 font-mono text-xs text-foreground">{row.label}</td>
                          <td
                            className="py-2 pr-3 text-right tabular-nums text-foreground"
                            data-testid={`text-stats-total-${row.key}`}
                          >
                            {row.s.totalRows.toLocaleString()}
                          </td>
                          <td
                            className="py-2 pr-3 text-muted-foreground text-xs"
                            data-testid={`text-stats-oldest-${row.key}`}
                          >
                            {formatOldest(row.s.oldestChangedAt)}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${row.s.rowsOlderThanRetention > 0 ? "text-amber-700 font-medium" : "text-muted-foreground"}`}
                            data-testid={`text-stats-prune-${row.key}`}
                          >
                            {row.s.rowsOlderThanRetention.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {statsData && statsData.adminSettingAuditByKey.length > 0 && (
                <div className="mt-4 border-t pt-3" data-testid="section-admin-setting-audit-by-key">
                  <button
                    type="button"
                    onClick={() => setShowSettingKeyBreakdown((v) => !v)}
                    className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-foreground"
                    aria-expanded={showSettingKeyBreakdown}
                    data-testid="toggle-setting-key-breakdown"
                  >
                    <ChevronRight
                      className={`w-3.5 h-3.5 transition-transform ${showSettingKeyBreakdown ? "rotate-90" : ""}`}
                    />
                    Break down admin_setting_audit by setting key
                    <span className="text-muted-foreground font-normal ml-1">
                      (top {statsData.adminSettingAuditByKey.length}
                      {statsData.adminSettingAuditDistinctKeys > statsData.adminSettingAuditByKey.length
                        ? ` of ${statsData.adminSettingAuditDistinctKeys.toLocaleString()}`
                        : ""}
                      )
                    </span>
                  </button>
                  {showSettingKeyBreakdown && (
                    <div className="overflow-x-auto mt-3">
                      <table
                        className="w-full text-sm"
                        data-testid="table-admin-setting-audit-by-key"
                      >
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground border-b">
                            <th className="py-2 pr-3 font-medium">Setting key</th>
                            <th className="py-2 pr-3 font-medium text-right">Total rows</th>
                            <th className="py-2 pr-3 font-medium">Oldest row</th>
                            <th className="py-2 pr-3 font-medium text-right">
                              {previewDaysParam !== null
                                ? `Would prune at ${previewDaysParam}d`
                                : `Older than ${data.retentionDays}d`}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {statsData.adminSettingAuditByKey.map((row) => (
                            <tr
                              key={row.settingKey}
                              data-testid={`row-stats-key-${row.settingKey}`}
                            >
                              <td className="py-2 pr-3 font-mono text-xs text-foreground break-all">
                                {row.settingKey || "(empty)"}
                              </td>
                              <td
                                className="py-2 pr-3 text-right tabular-nums text-foreground"
                                data-testid={`text-stats-key-total-${row.settingKey}`}
                              >
                                {row.totalRows.toLocaleString()}
                              </td>
                              <td
                                className="py-2 pr-3 text-muted-foreground text-xs"
                                data-testid={`text-stats-key-oldest-${row.settingKey}`}
                              >
                                {formatOldest(row.oldestChangedAt)}
                              </td>
                              <td
                                className={`py-2 pr-3 text-right tabular-nums ${row.rowsOlderThanRetention > 0 ? "text-amber-700 font-medium" : "text-muted-foreground"}`}
                                data-testid={`text-stats-key-prune-${row.settingKey}`}
                              >
                                {row.rowsOlderThanRetention.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {statsData.adminSettingAuditDistinctKeys > statsData.adminSettingAuditByKey.length && (
                        <p
                          className="text-xs text-muted-foreground mt-2"
                          data-testid="text-setting-key-truncated"
                        >
                          Showing the top {statsData.adminSettingAuditByKey.length} setting keys by row count.
                          {" "}
                          {(statsData.adminSettingAuditDistinctKeys - statsData.adminSettingAuditByKey.length).toLocaleString()}
                          {" "}more key{statsData.adminSettingAuditDistinctKeys - statsData.adminSettingAuditByKey.length === 1 ? " is" : "s are"} not shown.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-card rounded-lg border shadow-sm p-6 mb-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Daily prune activity</h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPruneManualOnly((v) => !v)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      pruneManualOnly
                        ? "bg-amber-100 border-amber-300 text-amber-800 hover:bg-amber-200"
                        : "bg-card border-border text-muted-foreground hover:bg-muted/50"
                    }`}
                    aria-pressed={pruneManualOnly}
                    data-testid="toggle-prune-manual-only"
                  >
                    Manual only{pruneManualOnly ? " ✓" : ""}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmPruneOpen(true)}
                    disabled={pruneMutation.isPending}
                    data-testid="button-prune-now"
                  >
                  {pruneMutation.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Pruning…
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Run prune now
                    </>
                  )}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <PruneTable
                  title="admin_setting_audit"
                  testId="admin"
                  events={pruneEventsData?.adminSettingAudit.events ?? []}
                  showWindow="days"
                  anomaly={pruneEventsData?.adminSettingAudit.anomaly}
                  onSelectEvent={(event, table) => setDrillSweep({ event, table })}
                  manualOnly={pruneManualOnly}
                />
                <PruneTable
                  title="stale_lease_threshold_audit"
                  testId="stale"
                  events={pruneEventsData?.staleLeaseThresholdAudit.events ?? []}
                  showWindow="days"
                  anomaly={pruneEventsData?.staleLeaseThresholdAudit.anomaly}
                  onSelectEvent={(event, table) => setDrillSweep({ event, table })}
                  manualOnly={pruneManualOnly}
                />
                <PruneTable
                  title="queue_timing_audit"
                  testId="queue"
                  events={pruneEventsData?.queueTimingAudit.events ?? []}
                  showWindow="days"
                  anomaly={pruneEventsData?.queueTimingAudit.anomaly}
                  onSelectEvent={(event, table) => setDrillSweep({ event, table })}
                  manualOnly={pruneManualOnly}
                />
                <PruneTable
                  title="blocked_ip per-IP cap"
                  testId="blocked-ip"
                  events={pruneEventsData?.blockedIpAudit.events ?? []}
                  showWindow="perIp"
                  windowLabel={
                    pruneEventsData
                      ? `Currently keeping the last ${pruneEventsData.blockedIpAudit.maxEntriesPerIp} entries per IP.`
                      : undefined
                  }
                  anomaly={pruneEventsData?.blockedIpAudit.anomaly}
                  onSelectEvent={(event, table) => setDrillSweep({ event, table })}
                  manualOnly={pruneManualOnly}
                />
                <PruneTable
                  title="client_contacts_audit"
                  testId="client-contacts"
                  events={pruneEventsData?.clientContactsAudit.events ?? []}
                  showWindow="days"
                  windowLabel={
                    pruneEventsData
                      ? `Currently keeping the last ${pruneEventsData.clientContactsAudit.retentionDays} days plus the latest ${pruneEventsData.clientContactsAudit.minPerContact} edits per contact.`
                      : undefined
                  }
                  anomaly={pruneEventsData?.clientContactsAudit.anomaly}
                  onSelectEvent={(event, table) => setDrillSweep({ event, table })}
                  manualOnly={pruneManualOnly}
                />
              </div>
            </div>

            <ClientContactsAuditRetentionSection />

            <div
              className="bg-card rounded-lg border shadow-sm p-6 mb-6"
              data-testid="card-blocked-ip-audit-cap"
            >
              <div className="flex items-center gap-2 mb-2">
                <Archive className="w-4 h-4 text-primary" />
                <h2
                  className="text-sm font-semibold text-foreground"
                  data-testid="text-blocked-ip-audit-cap-title"
                >
                  Blocked-IP change-history cap
                </h2>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Limits how many block / unblock / expiry-update rows are kept per IP. When an IP exceeds the cap, the oldest rows are trimmed and a notification is recorded for admins.
              </p>
              {!ipData ? (
                <div className="text-sm text-muted-foreground" data-testid="text-blocked-ip-audit-cap-loading">
                  Loading…
                </div>
              ) : (
                <>
                  <div className="flex items-end gap-3 mb-3">
                    <div className="flex-1">
                      <label
                        htmlFor="input-blocked-ip-audit-cap"
                        className="block text-sm font-medium text-foreground mb-1"
                      >
                        Maximum entries per IP
                      </label>
                      <Input
                        id="input-blocked-ip-audit-cap"
                        type="number"
                        inputMode="numeric"
                        min={ipData.minMax}
                        max={ipData.maxMax}
                        step={1}
                        value={ipDraft}
                        onChange={(e) => setIpDraft(e.target.value)}
                        data-testid="input-blocked-ip-audit-cap"
                      />
                    </div>
                    {(() => {
                      const n = Number.parseInt(ipDraft, 10);
                      const valid =
                        Number.isFinite(n) &&
                        Number.isInteger(n) &&
                        n >= ipData.minMax &&
                        n <= ipData.maxMax;
                      const dirty = valid && n !== ipData.maxEntriesPerIp;
                      const isLowering = dirty && n < ipData.maxEntriesPerIp;
                      return (
                        <>
                          <Button
                            disabled={!dirty || ipSaveMutation.isPending}
                            onClick={() => {
                              if (isLowering) {
                                setConfirmLowerIpCapOpen(true);
                              } else {
                                ipSaveMutation.mutate(n);
                              }
                            }}
                            data-testid="button-save-blocked-ip-audit-cap"
                          >
                            {ipSaveMutation.isPending ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={
                              ipSaveMutation.isPending ||
                              ipDraft === String(ipData.maxEntriesPerIp)
                            }
                            onClick={() => setIpDraft(String(ipData.maxEntriesPerIp))}
                            data-testid="button-reset-blocked-ip-audit-cap"
                          >
                            Reset
                          </Button>
                        </>
                      );
                    })()}
                  </div>
                  <div
                    className="text-xs text-muted-foreground mb-3"
                    data-testid="text-blocked-ip-audit-cap-bounds"
                  >
                    Allowed range: {ipData.minMax}–{ipData.maxMax} entries per IP.
                  </div>
                  {(() => {
                    const n = Number.parseInt(ipDraft, 10);
                    const valid =
                      Number.isFinite(n) &&
                      Number.isInteger(n) &&
                      n >= ipData.minMax &&
                      n <= ipData.maxMax;
                    if (valid || ipDraft === "") return null;
                    return (
                      <div
                        className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-3"
                        data-testid="status-blocked-ip-audit-cap-invalid"
                      >
                        <AlertTriangle className="w-4 h-4 mt-0.5" />
                        <span>
                          Enter a whole number between {ipData.minMax} and {ipData.maxMax}.
                        </span>
                      </div>
                    );
                  })()}
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div>
                      <dt className="text-muted-foreground">Currently keeping</dt>
                      <dd
                        className="font-medium text-foreground"
                        data-testid="text-blocked-ip-audit-cap-current"
                      >
                        Last {ipData.maxEntriesPerIp.toLocaleString()} change
                        {ipData.maxEntriesPerIp === 1 ? "" : "s"} per IP
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Source</dt>
                      <dd
                        className="font-medium text-foreground"
                        data-testid="text-blocked-ip-audit-cap-source"
                      >
                        {ipData.source === "setting"
                          ? "Saved by an admin"
                          : ipData.source === "env"
                            ? `Inherited from env (${ipData.envMax})`
                            : `Built-in default (${ipData.defaultMax})`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Last changed</dt>
                      <dd
                        className="font-medium text-foreground"
                        data-testid="text-blocked-ip-audit-cap-changed-at"
                      >
                        {ipData.lastEdited?.updatedAt
                          ? new Date(ipData.lastEdited.updatedAt).toLocaleString()
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Changed by</dt>
                      <dd
                        className="font-medium text-foreground"
                        data-testid="text-blocked-ip-audit-cap-changed-by"
                      >
                        {formatUser(ipData.lastEdited?.updatedBy ?? null)}
                      </dd>
                    </div>
                  </dl>
                  <AlertDialog
                    open={confirmLowerIpCapOpen}
                    onOpenChange={setConfirmLowerIpCapOpen}
                  >
                    <AlertDialogContent data-testid="dialog-confirm-lower-blocked-ip-cap">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Lower blocked-IP history cap?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Saving will immediately trim the oldest blocked-IP audit
                          rows for any IP whose history exceeds the new cap of{" "}
                          {Number.parseInt(ipDraft, 10)} entr
                          {Number.parseInt(ipDraft, 10) === 1 ? "y" : "ies"} per IP
                          (down from {ipData.maxEntriesPerIp}). Trimmed rows cannot
                          be recovered.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-cancel-lower-blocked-ip-cap">
                          Cancel
                        </AlertDialogCancel>
                        <AlertDialogAction
                          data-testid="button-confirm-lower-blocked-ip-cap"
                          onClick={() => {
                            setConfirmLowerIpCapOpen(false);
                            const n = Number.parseInt(ipDraft, 10);
                            if (
                              Number.isFinite(n) &&
                              Number.isInteger(n) &&
                              n >= ipData.minMax &&
                              n <= ipData.maxMax
                            ) {
                              ipSaveMutation.mutate(n);
                            }
                          }}
                        >
                          Lower and trim
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </div>

            <AuditPruneAnomalyAlertSection />

            <BlockedIpTrimAlertSection />

            <div className="bg-card rounded-lg border shadow-sm p-6">
              <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Recent changes</h2>
                </div>
                <div className="inline-flex rounded-md border overflow-hidden text-xs" data-testid="toggle-history-filter">
                  {([
                    { value: "all", label: "All" },
                    { value: "retention", label: "Retention days" },
                    { value: "ipCap", label: "Blocked-IP cap" },
                    { value: "manualPrune", label: "Manual prune" },
                  ] as const).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setHistoryFilter(opt.value)}
                      className={`px-2.5 py-1 ${
                        historyFilter === opt.value
                          ? "bg-gray-800 text-white"
                          : "bg-card text-foreground hover:bg-muted/50"
                      }`}
                      data-testid={`button-history-filter-${opt.value}`}
                      aria-pressed={historyFilter === opt.value}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {(() => {
                const filteredHistory = (historyData?.history ?? []).filter((entry) => {
                  if (historyFilter === "all") return true;
                  const isIpCap = entry.settingKey === "blocked_ip_audit_max_per_ip";
                  const isManualPrune = entry.settingKey === "audit_prune_manual";
                  if (historyFilter === "ipCap") return isIpCap;
                  if (historyFilter === "manualPrune") return isManualPrune;
                  return !isIpCap && !isManualPrune;
                });
                if (!historyData || filteredHistory.length === 0) {
                  return (
                    <div className="text-sm text-muted-foreground" data-testid="text-no-history">
                      {!historyData || historyData.history.length === 0
                        ? "No retention changes recorded yet."
                        : "No changes match this filter."}
                    </div>
                  );
                }
                return (
                <ul className="divide-y">
                  {filteredHistory.map((entry) => {
                    const isIpCap = entry.settingKey === "blocked_ip_audit_max_per_ip";
                    const isManualPrune = entry.settingKey === "audit_prune_manual";
                    const who = formatEditorAttribution(entry, "system");
                    const when = entry.changedAt
                      ? new Date(entry.changedAt).toLocaleString()
                      : "—";
                    let body: ReactNode;
                    if (isManualPrune) {
                      const v = entry.newValues ?? {};
                      const total =
                        (Number(v.adminSettingAuditDeleted) || 0) +
                        (Number(v.staleLeaseThresholdAuditDeleted) || 0) +
                        (Number(v.queueTimingAuditDeleted) || 0) +
                        (Number(v.blockedIpAuditDeleted) || 0);
                      body = (
                        <span className="text-foreground" data-testid={`text-history-change-${entry.id}`}>
                          <span className="text-xs text-muted-foreground mr-2">Manual prune</span>
                          removed <span className="font-medium">{total.toLocaleString()}</span> row{total === 1 ? "" : "s"}
                          {Number.isFinite(Number(v.retentionDays))
                            ? <> (retention {Number(v.retentionDays)}d)</>
                            : null}
                        </span>
                      );
                    } else if (entry.settingKey === "audit_prune_anomaly_config") {
                      const o = entry.oldValues ?? {};
                      const n = entry.newValues ?? {};
                      const diffs: string[] = [];
                      const fields: Array<[string, string]> = [
                        ["enabled", "enabled"],
                        ["minRows", "min rows"],
                        ["ratioMultiplier", "ratio×"],
                        ["baselineWindow", "window"],
                        ["cooldownMinutes", "cooldown"],
                      ];
                      for (const [key, label] of fields) {
                        if (String(o[key]) !== String(n[key])) {
                          diffs.push(`${label} ${o[key] ?? "—"}→${n[key] ?? "—"}`);
                        }
                      }
                      body = (
                        <span className="text-foreground" data-testid={`text-history-change-${entry.id}`}>
                          <span className="text-xs text-muted-foreground mr-2">Anomaly alert</span>
                          <span className="font-medium">
                            {diffs.length > 0 ? diffs.join(" · ") : "no-op save"}
                          </span>
                        </span>
                      );
                    } else {
                      const oldVal = isIpCap
                        ? entry.oldValues?.maxEntriesPerIp ?? "—"
                        : entry.oldValues?.retentionDays ?? "—";
                      const newVal = isIpCap
                        ? entry.newValues?.maxEntriesPerIp ?? "—"
                        : entry.newValues?.retentionDays ?? "—";
                      const unit = isIpCap ? "entries/IP" : "days";
                      const label = isIpCap ? "Blocked-IP cap" : "Retention";
                      body = (
                        <span className="text-foreground" data-testid={`text-history-change-${entry.id}`}>
                          <span className="text-xs text-muted-foreground mr-2">{label}</span>
                          <span className="font-medium">{oldVal}</span> → <span className="font-medium">{newVal}</span> {unit}
                        </span>
                      );
                    }
                    return (
                      <li
                        key={entry.id}
                        className="py-2 text-sm flex items-center justify-between gap-2 hover:bg-muted/50 rounded px-1 cursor-pointer"
                        data-testid={`row-history-${entry.id}`}
                        onClick={() => setDrillEntryId(entry.id)}
                        role="button"
                      >
                        {body}
                        <span className="text-muted-foreground flex items-center gap-2">
                          <span className="mr-1" data-testid={`text-history-user-${entry.id}`}>{who}</span>
                          <span data-testid={`text-history-time-${entry.id}`}>{when}</span>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        </span>
                      </li>
                    );
                  })}
                </ul>
                );
              })()}
            </div>
          </>
        )}

        <ShortenAuditDialog
          open={confirmSaveOpen}
          onOpenChange={setConfirmSaveOpen}
          draftNum={draftNum}
          currentDays={data?.retentionDays ?? null}
          stats={statsData ?? null}
          statsLoading={statsLoading}
          previewDaysParam={previewDaysParam}
          onConfirm={() => {
            setConfirmSaveOpen(false);
            saveMutation.mutate(draftNum);
          }}
        />

        <AlertDialog open={confirmPruneOpen} onOpenChange={setConfirmPruneOpen}>
          <AlertDialogContent data-testid="dialog-confirm-prune-now">
            <AlertDialogHeader>
              <AlertDialogTitle>Run audit prune now?</AlertDialogTitle>
              <AlertDialogDescription data-testid="text-confirm-prune-warning">
                This deletes audit rows older than the current retention window
                {data ? ` (${data.retentionDays} days)` : ""} from admin_setting_audit,
                stale_lease_threshold_audit, and queue_timing_audit, and trims the
                blocked_ip per-IP cap. Deleted rows cannot be recovered.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-prune">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-testid="button-confirm-prune"
                onClick={() => {
                  setConfirmPruneOpen(false);
                  pruneMutation.mutate();
                }}
              >
                Run prune
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={!!drillSweep} onOpenChange={(open) => !open && setDrillSweep(null)}>
          <DialogContent className="max-w-2xl" data-testid="dialog-sweep-row">
            <DialogHeader>
              <DialogTitle>Manual sweep details</DialogTitle>
              <DialogDescription>Full audit-log details for this manual prune.</DialogDescription>
            </DialogHeader>
            {drillSweep && (
              <div className="space-y-3 text-sm">
                <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">Table</dt>
                  <dd className="col-span-2 font-mono text-xs" data-testid="text-sweep-table">{drillSweep.table}</dd>
                  <dt className="text-muted-foreground">Triggered at</dt>
                  <dd className="col-span-2" data-testid="text-sweep-at">
                    {new Date(drillSweep.event.at).toLocaleString()}
                  </dd>
                  <dt className="text-muted-foreground">Triggered by</dt>
                  <dd className="col-span-2" data-testid="text-sweep-user">
                    {drillSweep.event.triggeredByName ||
                      drillSweep.event.triggeredBy ||
                      "system"}
                  </dd>
                  <dt className="text-muted-foreground">Trigger source</dt>
                  <dd className="col-span-2" data-testid="text-sweep-trigger">
                    {formatTrigger(drillSweep.event.trigger)}
                  </dd>
                  <dt className="text-muted-foreground">Rows removed</dt>
                  <dd className="col-span-2" data-testid="text-sweep-removed">
                    {drillSweep.event.removed.toLocaleString()}
                  </dd>
                  <dt className="text-muted-foreground">Window</dt>
                  <dd className="col-span-2" data-testid="text-sweep-window">
                    {drillSweep.event.maxAgeDays > 0
                      ? `${drillSweep.event.maxAgeDays} days`
                      : `keep last ${drillSweep.event.maxEntries} per scope`}
                  </dd>
                </dl>
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">Raw event</div>
                  <pre
                    className="bg-muted/50 border rounded p-2 text-xs overflow-auto max-h-40"
                    data-testid="text-sweep-raw"
                  >
                    {JSON.stringify(drillSweep.event, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={!!drillEntryId} onOpenChange={(open) => !open && setDrillEntryId(null)}>
          <DialogContent className="max-w-2xl" data-testid="dialog-audit-row">
            <DialogHeader>
              <DialogTitle>Audit log entry</DialogTitle>
              <DialogDescription>Full details for this admin_setting_audit row.</DialogDescription>
            </DialogHeader>
            {drillLoading && (
              <div className="py-6 flex items-center justify-center" data-testid="status-drill-loading">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {drillData?.entry && (
              <div className="space-y-3 text-sm">
                <dl className="grid grid-cols-3 gap-x-3 gap-y-2">
                  <dt className="text-muted-foreground">ID</dt>
                  <dd className="col-span-2 font-mono text-xs break-all" data-testid="text-drill-id">{drillData.entry.id}</dd>
                  <dt className="text-muted-foreground">Setting</dt>
                  <dd className="col-span-2" data-testid="text-drill-key">{drillData.entry.settingKey}</dd>
                  <dt className="text-muted-foreground">Scope</dt>
                  <dd className="col-span-2" data-testid="text-drill-scope">{drillData.entry.scope ?? "—"}</dd>
                  <dt className="text-muted-foreground">Changed by</dt>
                  <dd className="col-span-2" data-testid="text-drill-user">
                    {formatEditorAttribution(drillData.entry, "system")}
                  </dd>
                  <dt className="text-muted-foreground">Changed at</dt>
                  <dd className="col-span-2" data-testid="text-drill-time">
                    {drillData.entry.changedAt ? new Date(drillData.entry.changedAt).toLocaleString() : "—"}
                  </dd>
                </dl>
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">Old values</div>
                  <pre
                    className="bg-muted/50 border rounded p-2 text-xs overflow-auto max-h-40"
                    data-testid="text-drill-old-values"
                  >
                    {JSON.stringify(drillData.entry.oldValues ?? null, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-xs font-semibold text-muted-foreground mb-1">New values</div>
                  <pre
                    className="bg-muted/50 border rounded p-2 text-xs overflow-auto max-h-40"
                    data-testid="text-drill-new-values"
                  >
                    {JSON.stringify(drillData.entry.newValues ?? null, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

