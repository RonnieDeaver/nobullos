import React, { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { Phone, Save, Settings, Plus, X, Volume2, Activity, AlertTriangle, RefreshCw, RotateCcw, ExternalLink, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { LastEditedBadge, type LastEditedInfo } from "@/components/LastEditedBadge";
import { apiRequest } from "@/lib/queryClient";
import { ArchiveHealthSparkline, type SparklinePoint } from "@/components/admin/ArchiveHealthSparkline";
import { PageHeader } from "@/components/admin/PageHeader";

type ArchiveTrendPoint = {
  sampledAt: string;
  pendingStuckCount: number;
  oldestPendingAgeSeconds: number | null;
  recentFailedCount: number;
};

type ArchiveTrendResponse = {
  hours: number;
  points: ArchiveTrendPoint[];
};

function toSparkline(points: ArchiveTrendPoint[], key: keyof Omit<ArchiveTrendPoint, "sampledAt">): SparklinePoint[] {
  return points.map((p) => ({
    t: new Date(p.sampledAt).getTime(),
    v: p[key] as number | null,
  }));
}

type IvrMenuOption = { digit: string; label: string; phone: string };

type StuckRow = {
  id: string;
  client_id: string | null;
  twilio_sid: string | null;
  direction: string;
  from_number: string;
  to_number: string;
  created_at: string | null;
  updated_at?: string | null;
  recording_sid: string | null;
  archive_status: string | null;
  archive_attempts: number | null;
  archive_last_error: string | null;
};

type AlertConfig = {
  enabled: boolean;
  pendingHours: number;
  pendingCount: number;
  failedLookbackHours: number;
  failedCount: number;
  cooldownMinutes: number;
};

type AlertConfigLastEdited = {
  enabled: LastEditedInfo;
  pendingHours: LastEditedInfo;
  pendingCount: LastEditedInfo;
  failedLookbackHours: LastEditedInfo;
  failedCount: LastEditedInfo;
  cooldownMinutes: LastEditedInfo;
};

type ArchiveHealth = {
  config: {
    pendingHours: number;
    failedLookbackHours: number;
    maxAttempts: number;
    alertEnabled: boolean;
  };
  alertConfig: AlertConfig;
  alertConfigLastEdited: AlertConfigLastEdited;
  pendingStuck: { count: number; oldestAgeSeconds: number | null };
  recentFailures: { count: number; lookbackHours: number };
  stuckRows: StuckRow[];
  failedRows: StuckRow[];
};

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function ArchiveHealthCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ArchiveHealth>({
    queryKey: ["/api/admin/twilio/call-archive/health"],
    refetchInterval: 60_000,
  });

  // Task #1095: editable copy of the six alert thresholds. Hydrated
  // from the server payload so the inputs always reflect what's
  // actually live, and reset on refetch unless the user has
  // unsaved edits.
  const [alertDraft, setAlertDraft] = useState<AlertConfig | null>(null);
  const [alertDirty, setAlertDirty] = useState(false);
  useEffect(() => {
    if (!data?.alertConfig) return;
    if (!alertDirty) setAlertDraft(data.alertConfig);
  }, [data?.alertConfig, alertDirty]);

  const saveAlertConfigMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (payload: AlertConfig) => {
      const res = await apiRequest("PUT", "/api/admin/twilio/call-archive/alert-config", payload);
      return res.json() as Promise<{ alertConfig: AlertConfig }>;
    },
    onSuccess: () => {
      toast({ title: "Alert thresholds saved" });
      setAlertDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/health"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save thresholds", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const updateDraftField = <K extends keyof AlertConfig>(field: K, value: AlertConfig[K]) => {
    setAlertDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
    setAlertDirty(true);
  };

  const handleNumericChange = (field: keyof AlertConfig) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number.parseInt(e.target.value, 10);
    updateDraftField(field, (Number.isFinite(n) && n > 0 ? n : 1) as AlertConfig[typeof field]);
  };

  // Task #1094: 24h trend for the sparklines under each counter.
  // Refreshes on the same cadence as the snapshot writer (15min) —
  // a faster refetch wouldn't surface new points anyway.
  const { data: trendData } = useQuery<ArchiveTrendResponse>({
    queryKey: ["/api/admin/twilio/call-archive/health/trend"],
    refetchInterval: 5 * 60_000,
  });
  const trendPoints = trendData?.points ?? [];

  const enqueueOneMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/admin/twilio/call-archive/${id}/enqueue`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Re-enqueued", description: "Worker will pick up the row on the next tick." });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/health"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Re-enqueue failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const enqueueStuckMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/twilio/call-archive/enqueue-stuck`, {});
      return res.json() as Promise<{ candidates: number; enqueued: number; errors: { id: string; error: string }[] }>;
    },
    onSuccess: (result) => {
      const failed = result.errors?.length ?? 0;
      toast({
        title: `Re-enqueued ${result.enqueued} of ${result.candidates}`,
        description: failed > 0 ? `${failed} row(s) failed — see server logs.` : "All stuck rows pushed back to the worker.",
        variant: failed > 0 ? "destructive" : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/twilio/call-archive/health"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Batch re-enqueue failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const pendingCount = data?.pendingStuck.count ?? 0;
  const failedCount = data?.recentFailures.count ?? 0;
  const oldestAgeSeconds = data?.pendingStuck.oldestAgeSeconds ?? null;
  const pendingHours = data?.config.pendingHours ?? 1;
  const lookbackHours = data?.recentFailures.lookbackHours ?? 24;
  const healthy = !isLoading && !isError && pendingCount === 0 && failedCount === 0;

  const stuckRows = data?.stuckRows ?? [];
  const failedRows = data?.failedRows ?? [];

  return (
    <Card data-testid="card-archive-health">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Activity className="w-5 h-5" />
          Call recording archive — pipeline health
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2">
          {isLoading ? (
            <Badge variant="secondary" data-testid="badge-archive-health-status">Loading…</Badge>
          ) : isError ? (
            <Badge variant="destructive" data-testid="badge-archive-health-status">Failed to load</Badge>
          ) : healthy ? (
            <Badge className="bg-green-100 text-green-800" data-testid="badge-archive-health-status">Healthy</Badge>
          ) : (
            <Badge className="bg-amber-100 text-amber-800" data-testid="badge-archive-health-status">
              <AlertTriangle className="w-3 h-3 mr-1 inline" />
              Attention needed
            </Badge>
          )}
          {data && !data.config.alertEnabled && (
            <Badge variant="outline" data-testid="badge-archive-alert-off">Alert disabled</Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-archive-health"
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-md border p-3" data-testid="stat-pending-stuck">
            <div className="text-xs uppercase text-muted-foreground">Pending &gt; {pendingHours}h</div>
            <div className={`text-2xl font-semibold ${pendingCount > 0 ? "text-amber-700" : "text-green-700"}`} data-testid="text-pending-stuck-count">
              {pendingCount}
            </div>
            <div className="text-xs text-muted-foreground">
              row(s) waiting for the recording-status webhook
            </div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSparkline(trendPoints, "pendingStuckCount")}
                color="#b45309"
                testId="sparkline-pending-stuck"
              />
            </div>
          </div>
          <div className="rounded-md border p-3" data-testid="stat-oldest-pending">
            <div className="text-xs uppercase text-muted-foreground">Oldest pending</div>
            <div className="text-2xl font-semibold" data-testid="text-oldest-pending-age">
              {formatDuration(oldestAgeSeconds)}
            </div>
            <div className="text-xs text-muted-foreground">since the row was created</div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSparkline(trendPoints, "oldestPendingAgeSeconds")}
                color="#9c2c46"
                testId="sparkline-oldest-pending"
              />
            </div>
          </div>
          <div className="rounded-md border p-3" data-testid="stat-recent-failures">
            <div className="text-xs uppercase text-muted-foreground">Failed (last {lookbackHours}h)</div>
            <div className={`text-2xl font-semibold ${failedCount > 0 ? "text-red-700" : "text-green-700"}`} data-testid="text-recent-failures-count">
              {failedCount}
            </div>
            <div className="text-xs text-muted-foreground">
              attempts ≥ {data?.config.maxAttempts ?? 6} (bounded retries exhausted)
            </div>
            <div className="mt-2">
              <ArchiveHealthSparkline
                points={toSparkline(trendPoints, "recentFailedCount")}
                color="#b91c1c"
                testId="sparkline-recent-failures"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline" data-testid="link-archive-drilldown">
            <Link href="/admin/twilio/call-archive">
              <ExternalLink className="w-4 h-4 mr-1" />
              Open full archive view
            </Link>
          </Button>
          {pendingCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => enqueueStuckMutation.mutate()}
              disabled={enqueueStuckMutation.isPending}
              data-testid="button-enqueue-all-stuck"
            >
              <RotateCcw className="w-4 h-4 mr-1" />
              Re-enqueue all stuck pending ({pendingCount})
            </Button>
          )}
        </div>

        {stuckRows.length > 0 && (
          <div data-testid="section-stuck-rows">
            <h4 className="text-sm font-semibold mb-2">Stuck pending rows</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-3">Created</th>
                    <th className="py-1 pr-3">From → To</th>
                    <th className="py-1 pr-3">Recording SID</th>
                    <th className="py-1 pr-3">Last error</th>
                    <th className="py-1 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {stuckRows.map((r) => (
                    <tr key={r.id} className="border-b" data-testid={`row-stuck-${r.id}`}>
                      <td className="py-1 pr-3 whitespace-nowrap">{formatTimestamp(r.created_at)}</td>
                      <td className="py-1 pr-3 font-mono">{r.from_number} → {r.to_number}</td>
                      <td className="py-1 pr-3 font-mono">{r.recording_sid ?? <span className="text-amber-700">missing</span>}</td>
                      <td className="py-1 pr-3 max-w-[24rem] truncate" title={r.archive_last_error ?? ""} data-testid={`text-stuck-error-${r.id}`}>
                        {r.archive_last_error ?? <span className="text-muted-foreground">(no error yet)</span>}
                      </td>
                      <td className="py-1 pr-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => enqueueOneMutation.mutate(r.id)}
                          disabled={enqueueOneMutation.isPending}
                          data-testid={`button-enqueue-${r.id}`}
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1" />
                          Re-enqueue
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {failedRows.length > 0 && (
          <div data-testid="section-failed-rows">
            <h4 className="text-sm font-semibold mb-2">Recently failed rows</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-3">Failed at</th>
                    <th className="py-1 pr-3">From → To</th>
                    <th className="py-1 pr-3">Attempts</th>
                    <th className="py-1 pr-3">Last error</th>
                    <th className="py-1 pr-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {failedRows.map((r) => (
                    <tr key={r.id} className="border-b" data-testid={`row-failed-${r.id}`}>
                      <td className="py-1 pr-3 whitespace-nowrap">{formatTimestamp(r.updated_at)}</td>
                      <td className="py-1 pr-3 font-mono">{r.from_number} → {r.to_number}</td>
                      <td className="py-1 pr-3 text-center">{r.archive_attempts ?? 0}</td>
                      <td className="py-1 pr-3 max-w-[24rem] truncate" title={r.archive_last_error ?? ""} data-testid={`text-failed-error-${r.id}`}>
                        {r.archive_last_error ?? "—"}
                      </td>
                      <td className="py-1 pr-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => enqueueOneMutation.mutate(r.id)}
                          disabled={enqueueOneMutation.isPending}
                          data-testid={`button-enqueue-${r.id}`}
                        >
                          <RotateCcw className="w-3.5 h-3.5 mr-1" />
                          Re-enqueue
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!isLoading && !isError && stuckRows.length === 0 && failedRows.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-archive-empty">
            No stuck or recently-failed rows. The pipeline is draining cleanly.
          </p>
        )}

        {alertDraft && data?.alertConfigLastEdited && (
          <div className="border-t pt-4" data-testid="section-archive-alert-config">
            <h4 className="text-sm font-semibold mb-1">Alert thresholds</h4>
            <p className="text-xs text-muted-foreground mb-3">
              Tune the watcher that fires when this pipeline stalls. Saves take effect on the next 15-minute tick.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2 flex items-center gap-3">
                <input
                  id="alert-enabled"
                  type="checkbox"
                  checked={alertDraft.enabled}
                  onChange={(e) => updateDraftField("enabled", e.target.checked)}
                  data-testid="input-alert-enabled"
                  className="h-4 w-4"
                />
                <Label htmlFor="alert-enabled" className="cursor-pointer">
                  Alerting enabled
                </Label>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.enabled}
                  testId="last-edited-alert-enabled"
                />
              </div>

              <div>
                <Label htmlFor="alert-pending-hours">Pending stuck — hours</Label>
                <Input
                  id="alert-pending-hours"
                  type="number"
                  min={1}
                  value={alertDraft.pendingHours}
                  onChange={handleNumericChange("pendingHours")}
                  data-testid="input-alert-pending-hours"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Pending rows older than this trigger a check.
                </p>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.pendingHours}
                  testId="last-edited-alert-pending-hours"
                />
              </div>

              <div>
                <Label htmlFor="alert-pending-count">Pending stuck — count threshold</Label>
                <Input
                  id="alert-pending-count"
                  type="number"
                  min={1}
                  value={alertDraft.pendingCount}
                  onChange={handleNumericChange("pendingCount")}
                  data-testid="input-alert-pending-count"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Fire when pending stuck rows reach this count.
                </p>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.pendingCount}
                  testId="last-edited-alert-pending-count"
                />
              </div>

              <div>
                <Label htmlFor="alert-failed-lookback">Recent failures — lookback hours</Label>
                <Input
                  id="alert-failed-lookback"
                  type="number"
                  min={1}
                  value={alertDraft.failedLookbackHours}
                  onChange={handleNumericChange("failedLookbackHours")}
                  data-testid="input-alert-failed-lookback"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Window for counting recently-failed rows.
                </p>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.failedLookbackHours}
                  testId="last-edited-alert-failed-lookback"
                />
              </div>

              <div>
                <Label htmlFor="alert-failed-count">Recent failures — count threshold</Label>
                <Input
                  id="alert-failed-count"
                  type="number"
                  min={1}
                  value={alertDraft.failedCount}
                  onChange={handleNumericChange("failedCount")}
                  data-testid="input-alert-failed-count"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Fire when failed rows in the lookback window reach this count.
                </p>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.failedCount}
                  testId="last-edited-alert-failed-count"
                />
              </div>

              <div className="sm:col-span-2">
                <Label htmlFor="alert-cooldown">Per-bucket cooldown (minutes)</Label>
                <Input
                  id="alert-cooldown"
                  type="number"
                  min={1}
                  value={alertDraft.cooldownMinutes}
                  onChange={handleNumericChange("cooldownMinutes")}
                  data-testid="input-alert-cooldown"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Minimum gap between alerts for the same bucket (default 360 = 6h).
                </p>
                <LastEditedBadge
                  info={data.alertConfigLastEdited.cooldownMinutes}
                  testId="last-edited-alert-cooldown"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 mt-3">
              <Button
                size="sm"
                onClick={() => alertDraft && saveAlertConfigMutation.mutate(alertDraft)}
                disabled={!alertDirty || saveAlertConfigMutation.isPending}
                data-testid="button-save-alert-config"
              >
                <Save className="w-4 h-4 mr-1" />
                Save thresholds
              </Button>
              {alertDirty && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (data?.alertConfig) {
                      setAlertDraft(data.alertConfig);
                      setAlertDirty(false);
                    }
                  }}
                  disabled={saveAlertConfigMutation.isPending}
                  data-testid="button-reset-alert-config"
                >
                  Discard changes
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function TwilioAdmin() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [phoneNumbers, setPhoneNumbers] = useState<string[]>([]);
  const [newPhone, setNewPhone] = useState("");
  // Task #874: API Key + TwiML App SID power browser-based VOIP via the
  // Twilio Voice JS SDK. They live in `system_settings` (not env) so that
  // ops can rotate them without a redeploy.
  const [apiKeySid, setApiKeySid] = useState("");
  const [apiKeySecret, setApiKeySecret] = useState("");
  const [twimlAppSid, setTwimlAppSid] = useState("");
  // Task #876: Messaging Service SID enables RCS Business Messaging via
  // Twilio's channel selection. When set, outbound SMS go through the
  // Messaging Service (RCS for capable handsets, SMS otherwise) instead
  // of `from: <phone number>`. Empty input on save clears it back to the
  // legacy single-number send path.
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  // Task #884: result of the read-only "Test Messaging Service" check.
  // null = nothing tested yet; otherwise rendered inline beneath the input.
  const [messagingServiceTestResult, setMessagingServiceTestResult] = useState<
    | null
    | {
        ok: true;
        friendlyName: string | null;
        senderCount: number;
        breakdown: { phoneNumbers: number; alphaSenders: number; shortCodes: number };
      }
    | { ok: false; reason: string; message: string }
  >(null);
  // Migration 0041: Drive folder id where call recordings/transcripts go
  // when a call doesn't match a known client. Empty disables the mirror.

  const [ivrGreeting, setIvrGreeting] = useState("");
  const [ivrMenuOptions, setIvrMenuOptions] = useState<IvrMenuOption[]>([]);
  const [configLoaded, setConfigLoaded] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["/api/twilio/config"],
    queryFn: async () => {
      const res = await fetch("/api/twilio/config");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  useEffect(() => {
    if (config && !configLoaded) {
      if (config.phoneNumbers) setPhoneNumbers(config.phoneNumbers);
      if (config.ivrGreeting) setIvrGreeting(config.ivrGreeting);
      if (config.ivrMenuOptions?.length) setIvrMenuOptions(config.ivrMenuOptions);
      setConfigLoaded(true);
    }
  }, [config, configLoaded]);

  const saveConfigMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const body: any = { phoneNumbers };
      if (accountSid) body.accountSid = accountSid;
      if (authToken) body.authToken = authToken;
      const res = await fetch("/api/twilio/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Twilio configuration saved" });
      setAccountSid("");
      setAuthToken("");
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/config"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save config", description: err.message, variant: "destructive" });
    },
  });

  // Task #876: separate mutation for the Messaging Service SID so an
  // admin can save / clear it without re-entering Account SID + Auth
  // Token. Submitting an empty input is the explicit "turn off RCS
  // routing" gesture — we send `null` so the PUT handler clears the
  // stored value.
  const saveMessagingServiceMutation = useMutation({
    meta: { silent: true },
    mutationFn: async (action: "save" | "clear") => {
      const body: any = {
        messagingServiceSid: action === "clear" ? null : messagingServiceSid.trim(),
      };
      const res = await fetch("/api/twilio/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      return res.json();
    },
    onSuccess: (_data, action) => {
      toast({
        title: action === "clear" ? "Messaging Service cleared" : "Messaging Service SID saved",
      });
      setMessagingServiceSid("");
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/config"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({
        title: "Failed to save Messaging Service SID",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Task #884: read-only reachability check. Calls the new server endpoint
  // which fetches the Messaging Service via the Twilio SDK and inspects
  // its Sender Pool. Result is rendered inline (success: senders count;
  // failure: specific reason) so the admin gets actionable feedback
  // before clicking Save.
  const testMessagingServiceMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/twilio/messaging-service/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messagingServiceSid: messagingServiceSid.trim() }),
      });
      const data = await res.json();
      // The endpoint always returns a structured `{ ok, ... }` body; even
      // 4xx responses carry a usable `reason` + `message`. Surface those
      // through the same result panel so the user sees the same UI for
      // "format invalid" and "service not found".
      return data as
        | { ok: true; friendlyName: string | null; senderCount: number; breakdown: { phoneNumbers: number; alphaSenders: number; shortCodes: number } }
        | { ok: false; reason: string; message: string };
    },
    onSuccess: (data) => {
      setMessagingServiceTestResult(data);
    },
    onError: (err: any) => {
      setMessagingServiceTestResult({
        ok: false,
        reason: "unknown",
        message: err?.message || "Failed to reach the test endpoint",
      });
    },
  });

  // Task #874: separate mutation for browser calling so an admin can save
  // these three credentials without re-entering Account SID / Auth Token.
  const saveBrowserCallingMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const body: any = {};
      if (apiKeySid) body.apiKeySid = apiKeySid.trim();
      if (apiKeySecret) body.apiKeySecret = apiKeySecret;
      if (twimlAppSid) body.twimlAppSid = twimlAppSid.trim();
      if (Object.keys(body).length === 0) {
        throw new Error("Enter at least one value to save.");
      }
      const res = await fetch("/api/twilio/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Browser calling credentials saved" });
      setApiKeySid("");
      setApiKeySecret("");
      setTwimlAppSid("");
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/config"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save browser calling config", description: err.message, variant: "destructive" });
    },
  });

  const saveIvrMutation = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const validOptions = ivrMenuOptions.filter((o) => o.digit && o.label && o.phone);
      const res = await fetch("/api/twilio/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ivrGreeting: ivrGreeting || undefined,
          ivrMenuOptions: validOptions.length > 0 ? validOptions : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "IVR menu saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/twilio/config"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Failed to save IVR menu", description: err.message, variant: "destructive" });
    },
  });

  const addMenuOption = () => {
    const nextDigit = String(ivrMenuOptions.length + 1);
    setIvrMenuOptions([...ivrMenuOptions, { digit: nextDigit, label: "", phone: "" }]);
  };

  const updateMenuOption = (index: number, field: keyof IvrMenuOption, value: string) => {
    const updated = [...ivrMenuOptions];
    updated[index] = { ...updated[index], [field]: value };
    setIvrMenuOptions(updated);
  };

  const removeMenuOption = (index: number) => {
    setIvrMenuOptions(ivrMenuOptions.filter((_, i) => i !== index));
  };

  const isAdmin = user?.role === "ceo" || user?.role === "team_lead";
  // Task #1079: archive pipeline health endpoints are gated to CEO
  // (matching the existing /api/admin/twilio/call-archive endpoints),
  // so only render the card for users who can actually call them.
  const isCeo = user?.role === "ceo";

  if (!user) return null;

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-2 p-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <PageHeader
          title="Twilio Settings"
          icon={Phone}
          backHref="/admin/integrations"
        />

        {isAdmin && (
          <>
            {isCeo && <ArchiveHealthCard />}
            <Card data-testid="card-twilio-admin">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Settings className="w-5 h-5" />
                  Twilio Account Configuration
                </CardTitle>
                <CardDescription>
                  {config?.isConfigured ? (
                    <Badge className="bg-green-100 text-green-800">Connected</Badge>
                  ) : (
                    <Badge variant="secondary">Not configured</Badge>
                  )}
                  {config?.accountSid && <span className="ml-2 text-xs">SID: {config.accountSid}</span>}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="accountSid">Account SID</Label>
                  <Input
                    id="accountSid"
                    value={accountSid}
                    onChange={(e) => setAccountSid(e.target.value)}
                    placeholder={config?.isConfigured ? "••••••• (already set)" : "ACxxxxxxxxxxxxxxxx"}
                    data-testid="input-account-sid"
                  />
                  <LastEditedBadge
                    info={config?.lastEdited?.accountSid as LastEditedInfo}
                    testId="last-edited-account-sid"
                  />
                </div>
                <div>
                  <Label htmlFor="authToken">Auth Token</Label>
                  <Input
                    id="authToken"
                    type="password"
                    value={authToken}
                    onChange={(e) => setAuthToken(e.target.value)}
                    placeholder={config?.isConfigured ? "••••••• (already set)" : "Auth token"}
                    data-testid="input-auth-token"
                  />
                  <LastEditedBadge
                    info={config?.lastEdited?.authToken as LastEditedInfo}
                    testId="last-edited-auth-token"
                  />
                </div>
                <div>
                  <Label>Phone Numbers</Label>
                  <div className="space-y-2">
                    {phoneNumbers.map((phone, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input value={phone} readOnly className="flex-1" />
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPhoneNumbers(phoneNumbers.filter((_, i) => i !== idx))}
                          aria-label={`Remove phone ${phone}`}
                          data-testid={`button-remove-phone-${idx}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex items-center gap-2">
                      <Input
                        value={newPhone}
                        onChange={(e) => setNewPhone(e.target.value)}
                        placeholder="+1234567890"
                        data-testid="input-new-phone"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (newPhone.trim()) {
                            setPhoneNumbers([...phoneNumbers, newPhone.trim()]);
                            setNewPhone("");
                          }
                        }}
                        aria-label="Add phone number"
                        data-testid="button-add-phone"
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <LastEditedBadge
                    info={config?.lastEdited?.phoneNumbers as LastEditedInfo}
                    testId="last-edited-phone-numbers"
                  />
                </div>

                <Button
                  onClick={() => saveConfigMutation.mutate()}
                  disabled={saveConfigMutation.isPending}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-config"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Configuration
                </Button>

                <Separator />

                {/* Task #876: Messaging Service SID. When set, every
                    outbound SMS is sent through Twilio's Messaging
                    Service so RCS Business Messaging is used on
                    capable handsets and SMS is the automatic fallback.
                    The existing phone number must be added to the
                    service's Sender Pool in the Twilio Console first.
                    Treated as sensitive in the UI (masked placeholder)
                    for consistency with the Auth Token field. */}
                <div data-testid="section-messaging-service">
                  <Label htmlFor="messagingServiceSid">Messaging Service SID (RCS-ready)</Label>
                  <div className="flex items-center gap-2 mt-1">
                    {config?.messagingService?.isSet ? (
                      <Badge className="bg-green-100 text-green-800" data-testid="badge-messaging-service-status">
                        Configured
                      </Badge>
                    ) : (
                      <Badge variant="secondary" data-testid="badge-messaging-service-status">
                        Not configured
                      </Badge>
                    )}
                    {config?.messagingService?.messagingServiceSid && (
                      <span className="text-xs text-gray-600" data-testid="text-messaging-service-sid">
                        SID: {config.messagingService.messagingServiceSid}
                      </span>
                    )}
                  </div>
                  <Input
                    id="messagingServiceSid"
                    type="password"
                    value={messagingServiceSid}
                    onChange={(e) => {
                      setMessagingServiceSid(e.target.value);
                      // Task #884: clear any prior test result so the
                      // success/failure panel doesn't get confused with a
                      // freshly typed (but un-tested) SID.
                      if (messagingServiceTestResult) setMessagingServiceTestResult(null);
                    }}
                    placeholder={
                      config?.messagingService?.isSet
                        ? "••••••• (already set — enter a new SID to replace)"
                        : "MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                    }
                    className="mt-2"
                    data-testid="input-messaging-service-sid"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Optional. When set, outbound SMS is routed through this Messaging Service so Twilio
                    can pick RCS Business Messaging on supported handsets and fall back to SMS otherwise.
                    Leave blank and use Clear to revert to single-number SMS.
                  </p>
                  <LastEditedBadge
                    info={config?.lastEdited?.messagingServiceSid as LastEditedInfo}
                    testId="last-edited-messaging-service-sid"
                  />
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Button
                      onClick={() => saveMessagingServiceMutation.mutate("save")}
                      disabled={
                        saveMessagingServiceMutation.isPending || messagingServiceSid.trim().length === 0
                      }
                      className="bg-primary hover:bg-primary/90"
                      data-testid="button-save-messaging-service-sid"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      Save Messaging Service SID
                    </Button>
                    {/* Task #884: Test button. Read-only check that the
                        Messaging Service SID is reachable in the
                        configured account and has at least one sender
                        in its pool. Does not send an SMS. Disabled
                        until the input has a value (we never send the
                        already-stored SID for testing because it's
                        masked client-side). */}
                    <Button
                      variant="outline"
                      onClick={() => testMessagingServiceMutation.mutate()}
                      disabled={
                        testMessagingServiceMutation.isPending ||
                        messagingServiceSid.trim().length === 0
                      }
                      data-testid="button-test-messaging-service-sid"
                    >
                      {testMessagingServiceMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                      ) : (
                        <Activity className="w-4 h-4 mr-1" />
                      )}
                      Test Messaging Service
                    </Button>
                    {config?.messagingService?.isSet && (
                      <Button
                        variant="outline"
                        onClick={() => saveMessagingServiceMutation.mutate("clear")}
                        disabled={saveMessagingServiceMutation.isPending}
                        data-testid="button-clear-messaging-service-sid"
                      >
                        <X className="w-4 h-4 mr-1" />
                        Clear
                      </Button>
                    )}
                  </div>
                  {messagingServiceTestResult && (
                    <div
                      className={`mt-3 rounded-md border p-3 text-sm ${
                        messagingServiceTestResult.ok
                          ? "border-green-300 bg-green-50 text-green-900"
                          : "border-red-300 bg-red-50 text-red-900"
                      }`}
                      data-testid="result-messaging-service-test"
                    >
                      {messagingServiceTestResult.ok ? (
                        <div className="flex items-start gap-2">
                          <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <div>
                            <div className="font-medium" data-testid="text-messaging-service-test-success">
                              Messaging Service found
                              {messagingServiceTestResult.friendlyName
                                ? `: "${messagingServiceTestResult.friendlyName}"`
                                : ""}{" "}
                              — {messagingServiceTestResult.senderCount} sender
                              {messagingServiceTestResult.senderCount === 1 ? "" : "s"} in pool
                            </div>
                            <div className="text-xs mt-1 text-green-800">
                              {messagingServiceTestResult.breakdown.phoneNumbers} phone number
                              {messagingServiceTestResult.breakdown.phoneNumbers === 1 ? "" : "s"},{" "}
                              {messagingServiceTestResult.breakdown.alphaSenders} alpha sender
                              {messagingServiceTestResult.breakdown.alphaSenders === 1 ? "" : "s"},{" "}
                              {messagingServiceTestResult.breakdown.shortCodes} short code
                              {messagingServiceTestResult.breakdown.shortCodes === 1 ? "" : "s"}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                          <div data-testid="text-messaging-service-test-failure">
                            <div className="font-medium">{messagingServiceTestResult.message}</div>
                            <div className="text-xs mt-1 text-red-800">
                              Reason: {messagingServiceTestResult.reason}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Task #874: browser calling configuration. Admins create an API
                Key + Secret in the Twilio console (Account → Keys & Credentials)
                and a TwiML App whose Voice Request URL points at our
                /api/twilio/webhooks/voice-twiml-browser endpoint. The voice
                token endpoint refuses to mint tokens until all three values
                are present. */}
            <Card data-testid="card-browser-calling-admin">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Phone className="w-5 h-5" />
                  Browser Calling (Twilio Voice JS SDK)
                </CardTitle>
                <CardDescription className="space-y-2">
                  <div>
                    {config?.browserCalling?.isConfigured ? (
                      <Badge className="bg-green-100 text-green-800" data-testid="badge-browser-calling-status">Configured</Badge>
                    ) : (
                      <Badge variant="secondary" data-testid="badge-browser-calling-status">Not configured</Badge>
                    )}
                  </div>
                  <div className="text-xs text-gray-600">
                    Required for users with <em>Browser audio</em> call mode. Create an API Key in the Twilio Console
                    (Account → API keys & tokens), then create a TwiML App whose Voice Request URL is set to{" "}
                    <code className="px-1 py-0.5 bg-muted rounded break-all">
                      {typeof window !== "undefined" ? window.location.origin : ""}/api/twilio/webhooks/voice-twiml-browser
                    </code>
                    {" "}and HTTP POST. Use the API Key SID/Secret here, NOT your account auth token.
                  </div>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="apiKeySid">API Key SID</Label>
                  <Input
                    id="apiKeySid"
                    value={apiKeySid}
                    onChange={(e) => setApiKeySid(e.target.value)}
                    placeholder={config?.browserCalling?.apiKeySid ? `${config.browserCalling.apiKeySid} (already set)` : "SKxxxxxxxxxxxxxxxx"}
                    data-testid="input-api-key-sid"
                  />
                  <LastEditedBadge
                    info={config?.lastEdited?.apiKeySid as LastEditedInfo}
                    testId="last-edited-api-key-sid"
                  />
                </div>
                <div>
                  <Label htmlFor="apiKeySecret">API Key Secret</Label>
                  <Input
                    id="apiKeySecret"
                    type="password"
                    value={apiKeySecret}
                    onChange={(e) => setApiKeySecret(e.target.value)}
                    placeholder={config?.browserCalling?.apiKeySecretSet ? "••••••• (already set)" : "API key secret"}
                    data-testid="input-api-key-secret"
                  />
                  <LastEditedBadge
                    info={config?.lastEdited?.apiKeySecret as LastEditedInfo}
                    testId="last-edited-api-key-secret"
                  />
                </div>
                <div>
                  <Label htmlFor="twimlAppSid">TwiML App SID</Label>
                  <Input
                    id="twimlAppSid"
                    value={twimlAppSid}
                    onChange={(e) => setTwimlAppSid(e.target.value)}
                    placeholder={config?.browserCalling?.twimlAppSid ? `${config.browserCalling.twimlAppSid} (already set)` : "APxxxxxxxxxxxxxxxx"}
                    data-testid="input-twiml-app-sid"
                  />
                  <LastEditedBadge
                    info={config?.lastEdited?.twimlAppSid as LastEditedInfo}
                    testId="last-edited-twiml-app-sid"
                  />
                </div>
                <Button
                  onClick={() => saveBrowserCallingMutation.mutate()}
                  disabled={saveBrowserCallingMutation.isPending}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-browser-calling"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Browser Calling
                </Button>
              </CardContent>
            </Card>

            <Card data-testid="card-ivr-config">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Volume2 className="w-5 h-5" />
                  IVR Menu Configuration
                </CardTitle>
                <CardDescription>
                  Customize the phone menu callers hear when no team member answers. This is the final fallback after smart routing.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <Label htmlFor="ivrGreeting">Greeting Message</Label>
                  <Textarea
                    id="ivrGreeting"
                    value={ivrGreeting}
                    onChange={(e) => setIvrGreeting(e.target.value)}
                    placeholder="Thank you for calling. Press 1 for Sales, or press 2 for Account Management."
                    rows={3}
                    className="mt-1"
                    data-testid="input-ivr-greeting"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    This message is read aloud to callers. Include the menu options so they know which digit to press.
                  </p>
                  <LastEditedBadge
                    info={config?.lastEdited?.ivrGreeting as LastEditedInfo}
                    testId="last-edited-ivr-greeting"
                  />
                </div>

                <Separator />

                <div>
                  <div className="flex items-center justify-between mb-3">
                    <Label>Menu Options</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={addMenuOption}
                      disabled={ivrMenuOptions.length >= 9}
                      data-testid="button-add-ivr-option"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Option
                    </Button>
                  </div>

                  {ivrMenuOptions.length === 0 && (
                    <p className="text-sm text-muted-foreground py-4 text-center border rounded-md border-dashed">
                      No menu options configured. Add options to define where each key press routes callers.
                    </p>
                  )}

                  <div className="space-y-3">
                    {ivrMenuOptions.map((option, idx) => (
                      <div key={idx} className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg" data-testid={`ivr-option-${idx}`}>
                        <div className="w-16 shrink-0">
                          <Label className="text-xs">Key</Label>
                          <Input
                            value={option.digit}
                            onChange={(e) => updateMenuOption(idx, "digit", e.target.value.replace(/[^0-9]/g, "").slice(0, 1))}
                            className="text-center font-mono text-lg"
                            maxLength={1}
                            data-testid={`input-ivr-digit-${idx}`}
                          />
                        </div>
                        <div className="flex-1">
                          <Label className="text-xs">Label</Label>
                          <Input
                            value={option.label}
                            onChange={(e) => updateMenuOption(idx, "label", e.target.value)}
                            placeholder="e.g. Sales"
                            data-testid={`input-ivr-label-${idx}`}
                          />
                        </div>
                        <div className="flex-1">
                          <Label className="text-xs">Forward To</Label>
                          <Input
                            value={option.phone}
                            onChange={(e) => updateMenuOption(idx, "phone", e.target.value)}
                            placeholder="+15551234567"
                            data-testid={`input-ivr-phone-${idx}`}
                          />
                        </div>
                        <div className="pt-5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeMenuOption(idx)}
                            aria-label={`Remove menu option ${idx + 1}`}
                            data-testid={`button-remove-ivr-option-${idx}`}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <LastEditedBadge
                    info={config?.lastEdited?.ivrMenuOptions as LastEditedInfo}
                    testId="last-edited-ivr-menu-options"
                  />
                </div>

                <Button
                  onClick={() => saveIvrMutation.mutate()}
                  disabled={saveIvrMutation.isPending}
                  className="bg-primary hover:bg-primary/90"
                  data-testid="button-save-ivr"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save IVR Menu
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
