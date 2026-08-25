/**
 * Task #4336 — SMS consent admin console (/admin/sms-consent).
 *
 * Team-lead surface over the per-phone consent ledger:
 *   - state counts + searchable/filterable ledger with manual state set
 *   - append-only keyword/event history (STOP/START/HELP, manual, blocks)
 *   - automated-send gate audit (every allow/block decision)
 *   - settings: automated-send kill switch + quiet-hours window and
 *     opt-out-storm alert knobs
 *
 * Server routes are requireTeamLead-gated; this page shows whatever the API
 * grants and surfaces 403s as an access note.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RefreshCw, ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";
import type { SmsConsentState } from "@/components/SmsConsentBadge";

type LedgerRow = {
  id: string;
  phoneNormalized: string;
  phoneMatchKey: string;
  state: SmsConsentState;
  source: string;
  evidence: string | null;
  timezone: string | null;
  optedInAt: string | null;
  optedOutAt: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type LedgerResponse = {
  rows: LedgerRow[];
  total: number;
  countsByState: Record<string, number>;
};

type EventRow = {
  id: string;
  phoneNormalized: string;
  eventType: string;
  keyword: string | null;
  messageSid: string | null;
  source: string | null;
  detail: string | null;
  createdAt: string;
};

type GateAuditRow = {
  id: string;
  phoneNormalized: string;
  purpose: string;
  outcome: string;
  consentState: string | null;
  detail: string | null;
  requestedByUserId: string | null;
  createdAt: string;
};

type SettingsResponse = {
  gate: {
    automatedSendsEnabled: boolean;
    sendWindowStartHourLocal: number;
    sendWindowEndHourLocal: number;
  };
  storm: {
    enabled: boolean;
    windowMinutes: number;
    threshold: number;
    cooldownMinutes: number;
  };
};

const STATE_BADGE: Record<string, { cls: string; label: string }> = {
  opted_in: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", label: "Opted in" },
  opted_out: { cls: "bg-red-50 text-red-700 border-red-200", label: "Opted out" },
  unknown: { cls: "bg-gray-100 text-gray-600 border-gray-200", label: "Unknown" },
};

const OUTCOME_BADGE: Record<string, string> = {
  allowed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  send_failed: "bg-amber-50 text-amber-700 border-amber-200",
};

function StateBadge({ state }: { state: string }) {
  const s = STATE_BADGE[state] ?? STATE_BADGE.unknown;
  return (
    <Badge variant="outline" className={`text-[10px] ${s.cls}`} data-testid={`ledger-state-${state}`}>
      {s.label}
    </Badge>
  );
}

function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function isForbidden(err: unknown): boolean {
  return err instanceof Error && /^403:/.test(err.message);
}

export default function SmsConsentAdmin() {
  const queryClient = useQueryClient();
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [auditOutcomeFilter, setAuditOutcomeFilter] = useState<string>("all");
  const [manualRow, setManualRow] = useState<LedgerRow | null>(null);
  const [manualState, setManualState] = useState<SmsConsentState>("opted_in");
  const [manualNote, setManualNote] = useState("");

  const LIMIT = 50;

  const ledgerQuery = useQuery<LedgerResponse>({
    queryKey: ["/api/admin/sms-consent/ledger", stateFilter, search, ledgerOffset],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(LIMIT), offset: String(ledgerOffset) });
      if (stateFilter !== "all") params.set("state", stateFilter);
      if (search) params.set("search", search);
      const res = await apiRequest("GET", `/api/admin/sms-consent/ledger?${params}`);
      return res.json();
    },
  });

  const eventsQuery = useQuery<{ rows: EventRow[] }>({
    queryKey: ["/api/admin/sms-consent/events"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/sms-consent/events?limit=50");
      return res.json();
    },
  });

  const gateAuditQuery = useQuery<{ rows: GateAuditRow[] }>({
    queryKey: ["/api/admin/sms-consent/gate-audit", auditOutcomeFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (auditOutcomeFilter !== "all") params.set("outcome", auditOutcomeFilter);
      const res = await apiRequest("GET", `/api/admin/sms-consent/gate-audit?${params}`);
      return res.json();
    },
  });

  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ["/api/admin/sms-consent/settings"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/admin/sms-consent/settings");
      return res.json();
    },
  });

  const [settingsDraft, setSettingsDraft] = useState<SettingsResponse | null>(null);
  const settings = settingsDraft ?? settingsQuery.data ?? null;

  const saveSettings = useMutation({
    mutationFn: async (next: SettingsResponse) => {
      const res = await apiRequest("PUT", "/api/admin/sms-consent/settings", next);
      return (await res.json()) as SettingsResponse;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["/api/admin/sms-consent/settings"], next);
      setSettingsDraft(null);
      toast({ title: "SMS consent settings saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save settings", description: err.message, variant: "destructive" });
    },
  });

  const manualMutation = useMutation({
    mutationFn: async (input: { phone: string; state: SmsConsentState; note: string }) => {
      const res = await apiRequest("POST", "/api/admin/sms-consent/manual", input);
      return res.json();
    },
    onSuccess: () => {
      setManualRow(null);
      setManualNote("");
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/sms-consent/ledger"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/sms-consent/events"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-consent/status"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/sms-consent/status-batch"] });
      toast({ title: "Consent state updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update consent", description: err.message, variant: "destructive" });
    },
  });

  if (ledgerQuery.error && isForbidden(ledgerQuery.error)) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>SMS Consent</CardTitle>
            <CardDescription>Team-lead access is required for the consent ledger.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const counts = ledgerQuery.data?.countsByState ?? {};
  const total = ledgerQuery.data?.total ?? 0;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-4" data-testid="page-sms-consent-admin">
      <PageHeader
        title="SMS Consent"
        backHref="/admin/twilio"
        backLabel="Twilio Admin"
        backTestId="button-back-twilio-admin"
        subtitle="Per-number consent ledger, STOP/START keyword events, and the automated-send gate."
        actions={
          <div className="flex items-center gap-2 text-xs" data-testid="consent-state-counts">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-50 text-emerald-700">
              <ShieldCheck className="w-3 h-3" /> {counts.opted_in ?? 0} opted in
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-50 text-red-700">
              <ShieldOff className="w-3 h-3" /> {counts.opted_out ?? 0} opted out
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 text-gray-600">
              <ShieldQuestion className="w-3 h-3" /> {counts.unknown ?? 0} unknown
            </span>
          </div>
        }
      />

      {/* Settings */}
      <Card data-testid="card-sms-consent-settings">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Automated-send gate & alerts</CardTitle>
          <CardDescription>
            The gate applies to automated SMS only — human 1:1 console sends bypass it (the sender
            sees the recipient&apos;s consent state instead). Quiet hours are recipient-local.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!settings ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Automated sends enabled</Label>
                    <p className="text-xs text-muted-foreground">
                      Kill switch. OFF blocks every automated SMS regardless of consent.
                    </p>
                  </div>
                  <Switch
                    checked={settings.gate.automatedSendsEnabled}
                    onCheckedChange={(v) =>
                      setSettingsDraft({
                        ...settings,
                        gate: { ...settings.gate, automatedSendsEnabled: v },
                      })
                    }
                    data-testid="switch-automated-sends"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <Label className="text-xs" htmlFor="sms-window-start">Send window start (local hour)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={settings.gate.sendWindowStartHourLocal}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settings,
                          gate: {
                            ...settings.gate,
                            sendWindowStartHourLocal: Number(e.target.value),
                          },
                        })
                      }
                      id="sms-window-start" data-testid="input-window-start"
                    />
                  </div>
                  <div className="flex-1">
                    <Label className="text-xs" htmlFor="sms-window-end">Send window end (local hour)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      value={settings.gate.sendWindowEndHourLocal}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settings,
                          gate: {
                            ...settings.gate,
                            sendWindowEndHourLocal: Number(e.target.value),
                          },
                        })
                      }
                      id="sms-window-end" data-testid="input-window-end"
                    />
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Opt-out storm alert</Label>
                    <p className="text-xs text-muted-foreground">
                      Slack alert when opt-outs spike within the rolling window.
                    </p>
                  </div>
                  <Switch
                    checked={settings.storm.enabled}
                    onCheckedChange={(v) =>
                      setSettingsDraft({
                        ...settings,
                        storm: { ...settings.storm, enabled: v },
                      })
                    }
                    data-testid="switch-storm-alert"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs" htmlFor="sms-storm-window">Window (min)</Label>
                    <Input
                      type="number"
                      min={5}
                      max={1440}
                      value={settings.storm.windowMinutes}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settings,
                          storm: { ...settings.storm, windowMinutes: Number(e.target.value) },
                        })
                      }
                      id="sms-storm-window" data-testid="input-storm-window"
                    />
                  </div>
                  <div>
                    <Label className="text-xs" htmlFor="sms-storm-threshold">Threshold</Label>
                    <Input
                      type="number"
                      min={1}
                      max={1000}
                      value={settings.storm.threshold}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settings,
                          storm: { ...settings.storm, threshold: Number(e.target.value) },
                        })
                      }
                      id="sms-storm-threshold" data-testid="input-storm-threshold"
                    />
                  </div>
                  <div>
                    <Label className="text-xs" htmlFor="sms-storm-cooldown">Cooldown (min)</Label>
                    <Input
                      type="number"
                      min={0}
                      max={10080}
                      value={settings.storm.cooldownMinutes}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settings,
                          storm: { ...settings.storm, cooldownMinutes: Number(e.target.value) },
                        })
                      }
                      id="sms-storm-cooldown" data-testid="input-storm-cooldown"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {settingsDraft && (
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" size="sm" onClick={() => setSettingsDraft(null)} data-testid="button-settings-cancel">
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => settingsDraft && saveSettings.mutate(settingsDraft)}
                disabled={saveSettings.isPending}
                data-testid="button-settings-save"
              >
                {saveSettings.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
                Save settings
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ledger */}
      <Card data-testid="card-consent-ledger">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base">Consent ledger</CardTitle>
              <CardDescription>{total} number(s) tracked</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setLedgerOffset(0);
                  setSearch(searchDraft.trim());
                }}
                className="flex items-center gap-2"
              >
                <Input
                  placeholder="Search digits…"
                  aria-label="Search consent ledger by digits"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  className="h-8 w-40"
                  data-testid="input-ledger-search"
                />
              </form>
              <Select
                value={stateFilter}
                onValueChange={(v) => {
                  setLedgerOffset(0);
                  setStateFilter(v);
                }}
              >
                <SelectTrigger className="h-8 w-36" data-testid="select-ledger-state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  <SelectItem value="opted_in">Opted in</SelectItem>
                  <SelectItem value="opted_out">Opted out</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => ledgerQuery.refetch()}
                aria-label="Refresh ledger"
                data-testid="button-ledger-refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {ledgerQuery.isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (ledgerQuery.data?.rows.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center" data-testid="ledger-empty">
              No ledger rows{search || stateFilter !== "all" ? " match the current filter" : " yet — run the backfill prod-action to seed known numbers"}.
            </p>
          ) : (
            <div className="divide-y">
              {ledgerQuery.data!.rows.map((row) => (
                <div key={row.id} className="py-2 flex items-center gap-3 flex-wrap" data-testid={`ledger-row-${row.phoneMatchKey}`}>
                  <span className="font-mono text-sm w-32">{row.phoneNormalized}</span>
                  <StateBadge state={row.state} />
                  <span className="text-xs text-muted-foreground">{row.source}</span>
                  <span className="text-xs text-muted-foreground flex-1 min-w-[160px] truncate" title={row.evidence ?? undefined}>
                    {row.evidence ?? "—"}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {fmtTs(row.updatedAt)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setManualRow(row);
                      setManualState(row.state === "opted_out" ? "opted_in" : "opted_out");
                      setManualNote("");
                    }}
                    data-testid={`button-set-state-${row.phoneMatchKey}`}
                  >
                    Set state
                  </Button>
                </div>
              ))}
            </div>
          )}
          {total > LIMIT && (
            <div className="flex items-center justify-between mt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={ledgerOffset === 0}
                onClick={() => setLedgerOffset(Math.max(0, ledgerOffset - LIMIT))}
                data-testid="button-ledger-prev"
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                {ledgerOffset + 1}–{Math.min(ledgerOffset + LIMIT, total)} of {total}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={ledgerOffset + LIMIT >= total}
                onClick={() => setLedgerOffset(ledgerOffset + LIMIT)}
                data-testid="button-ledger-next"
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Events */}
        <Card data-testid="card-consent-events">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent consent events</CardTitle>
            <CardDescription>STOP/START/HELP keywords, manual changes, Twilio blocks, backfills</CardDescription>
          </CardHeader>
          <CardContent>
            {eventsQuery.isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (eventsQuery.data?.rows.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center" data-testid="events-empty">
                No consent events yet.
              </p>
            ) : (
              <div className="divide-y">
                {eventsQuery.data!.rows.map((ev) => (
                  <div key={ev.id} className="py-2 text-xs flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-[10px]">{ev.eventType}</Badge>
                    <span className="font-mono">{ev.phoneNormalized}</span>
                    {ev.keyword && <span className="font-semibold">&ldquo;{ev.keyword}&rdquo;</span>}
                    <span className="text-muted-foreground flex-1 min-w-[120px] truncate" title={ev.detail ?? undefined}>
                      {ev.detail ?? ""}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap">{fmtTs(ev.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Gate audit */}
        <Card data-testid="card-gate-audit">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Send-gate audit</CardTitle>
                <CardDescription>Every automated-send evaluation (allowed and blocked)</CardDescription>
              </div>
              <Select value={auditOutcomeFilter} onValueChange={setAuditOutcomeFilter}>
                <SelectTrigger className="h-8 w-44" data-testid="select-audit-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  <SelectItem value="allowed">Allowed</SelectItem>
                  <SelectItem value="blocked_kill_switch">Blocked: kill switch</SelectItem>
                  <SelectItem value="blocked_no_consent">Blocked: no consent</SelectItem>
                  <SelectItem value="blocked_opted_out">Blocked: opted out</SelectItem>
                  <SelectItem value="blocked_quiet_hours">Blocked: quiet hours</SelectItem>
                  <SelectItem value="blocked_invalid_phone">Blocked: invalid phone</SelectItem>
                  <SelectItem value="send_failed">Send failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {gateAuditQuery.isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (gateAuditQuery.data?.rows.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center" data-testid="gate-audit-empty">
                No automated-send attempts yet (nothing automated exists — the gate ships ahead of it).
              </p>
            ) : (
              <div className="divide-y">
                {gateAuditQuery.data!.rows.map((row) => (
                  <div key={row.id} className="py-2 text-xs flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${OUTCOME_BADGE[row.outcome] ?? "bg-red-50 text-red-700 border-red-200"}`}
                    >
                      {row.outcome}
                    </Badge>
                    <span className="font-mono">{row.phoneNormalized}</span>
                    <span className="font-medium">{row.purpose}</span>
                    <span className="text-muted-foreground flex-1 min-w-[120px] truncate" title={row.detail ?? undefined}>
                      {row.detail ?? ""}
                    </span>
                    <span className="text-muted-foreground whitespace-nowrap">{fmtTs(row.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Manual set dialog */}
      <Dialog open={manualRow !== null} onOpenChange={(open) => !open && setManualRow(null)}>
        <DialogContent data-testid="dialog-manual-consent">
          <DialogHeader>
            <DialogTitle>Set consent state</DialogTitle>
            <DialogDescription>
              {manualRow?.phoneNormalized} — current state: {manualRow?.state}. Manual changes are
              recorded in the event history with your user attribution.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">New state</Label>
              <Select value={manualState} onValueChange={(v) => setManualState(v as SmsConsentState)}>
                <SelectTrigger data-testid="select-manual-state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opted_in">Opted in</SelectItem>
                  <SelectItem value="opted_out">Opted out</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Note (required — why is this being changed?)</Label>
              <Textarea
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
                placeholder="e.g. Client emailed asking to stop texts; verbal consent on 8/10 call…"
                rows={3}
                data-testid="input-manual-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setManualRow(null)} data-testid="button-manual-cancel">
              Cancel
            </Button>
            <Button
              onClick={() =>
                manualRow &&
                manualMutation.mutate({
                  phone: manualRow.phoneNormalized,
                  state: manualState,
                  note: manualNote.trim(),
                })
              }
              disabled={manualMutation.isPending || manualNote.trim().length < 3}
              data-testid="button-manual-save"
            >
              {manualMutation.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
