import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Gauge,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/admin/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CriteriaBuilder, emptyCriteria } from "@/components/criteria/CriteriaBuilder";
import { type CriteriaSet } from "@shared/criteria";
import {
  ENGAGEMENT_MIN_COUNT_MAX,
  ENGAGEMENT_MIN_COUNT_MIN,
  ENGAGEMENT_WINDOW_MAX_DAYS,
  ENGAGEMENT_WINDOW_MIN_DAYS,
  SCORE_POINTS_MAX,
  SCORE_POINTS_MIN,
  SCORE_RANGE_MAX,
  SCORE_RANGE_MIN,
  engagementDirectionLabels,
  engagementDirections,
  engagementEventTypeLabels,
  engagementEventTypes,
  type EngagementDirection,
  type EngagementEventType,
  type ScoreBreakdownEntry,
  type ScoreConfigWithRules,
  type ScoreRule,
} from "@shared/schema";

/**
 * Task #4333 — Scoring admin surface (team_lead+).
 *
 * Deterministic fit + engagement scoring config: the score range/enabled
 * switch, the point rules (fit = shared criteria over record properties,
 * engagement = activity counts in bounded windows), a sample-record
 * preview, and the sweep status strip. Every mutation recomputes scores
 * synchronously server-side, so saving here visibly re-ranks the board.
 */

const CONFIG_QUERY_KEY = ["/api/scoring/deal/config"] as const;

interface SweepStatus {
  startedAt?: string;
  durationMs?: number;
  recordsScored?: number;
  rowsWritten?: number;
  orphansReaped?: number;
  cleared?: number;
  notes?: string[];
  errors?: string[];
}

interface ConfigPayload {
  config: ScoreConfigWithRules;
  maxRules: number;
  sweep: {
    status: SweepStatus | null;
    enabledSetting: string | null;
    intervalSetting: string | null;
  };
}

interface RecomputeResult {
  scored: number;
  written: number;
  orphansReaped: number;
  cleared: number;
  note: string | null;
}

interface PreviewComputed {
  score: number;
  fitScore: number;
  engagementScore: number;
  breakdown: ScoreBreakdownEntry[];
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ruleSummary(rule: ScoreRule): string {
  if (rule.kind === "fit") return "Record properties match the criteria";
  const noun = engagementEventTypeLabels[rule.eventType as EngagementEventType] ?? rule.eventType;
  const dir =
    rule.direction && rule.direction !== "any"
      ? `${engagementDirectionLabels[rule.direction as EngagementDirection].toLowerCase()} `
      : "";
  return `≥ ${rule.minCount ?? 1} ${dir}${(noun ?? "event").toLowerCase()} in the last ${rule.windowDays} days`;
}

export default function Scoring() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const configQuery = useQuery<ConfigPayload>({ queryKey: [...CONFIG_QUERY_KEY] });
  const payload = configQuery.data;
  const config = payload?.config;
  const rules = config?.rules ?? [];

  function afterScoresChanged() {
    void queryClient.invalidateQueries({ queryKey: [...CONFIG_QUERY_KEY] });
    // Scores ride on the board/detail payloads — refresh them too.
    void queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
  }

  // ── Config form ────────────────────────────────────────────────────────────
  const [rangeDraft, setRangeDraft] = useState<{ min: string; max: string } | null>(null);
  const min = rangeDraft?.min ?? (config ? String(config.scoreMin) : "0");
  const max = rangeDraft?.max ?? (config ? String(config.scoreMax) : "100");
  const rangeDirty =
    config !== undefined &&
    rangeDraft !== null &&
    (Number(min) !== config.scoreMin || Number(max) !== config.scoreMax);

  const configMutation = useMutation({
    mutationFn: async (body: { scoreMin?: number; scoreMax?: number; isEnabled?: boolean }) => {
      const res = await apiRequest("PUT", "/api/scoring/deal/config", body);
      return res.json() as Promise<{ config: ScoreConfigWithRules; recompute: RecomputeResult }>;
    },
    onSuccess: (data) => {
      setRangeDraft(null);
      toast({
        title: "Scoring config saved",
        description: `${data.recompute.scored} deals rescored.`,
      });
      afterScoresChanged();
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't save config", description: error.message, variant: "destructive" });
    },
  });

  const recomputeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/scoring/deal/recompute");
      return res.json() as Promise<RecomputeResult>;
    },
    onSuccess: (data) => {
      toast({
        title: "Scores recomputed",
        description: data.note ?? `${data.scored} deals scored, ${data.written} updated.`,
      });
      afterScoresChanged();
    },
    onError: (error: Error) => {
      toast({ title: "Recompute failed", description: error.message, variant: "destructive" });
    },
  });

  // ── Rule dialog / delete state ─────────────────────────────────────────────
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ScoreRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<ScoreRule | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (ruleId: string) => {
      const res = await apiRequest("DELETE", `/api/scoring/rules/${ruleId}`);
      return res.json() as Promise<{ deleted: boolean; recompute: RecomputeResult | null }>;
    },
    onSuccess: () => {
      setDeletingRule(null);
      toast({ title: "Rule deleted" });
      afterScoresChanged();
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't delete rule", description: error.message, variant: "destructive" });
    },
  });

  const sweep = payload?.sweep;
  const atRuleCap = payload !== undefined && rules.length >= payload.maxRules;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6" data-testid="page-scoring-admin">
      <PageHeader
        title="Deal scoring"
        backHref="/"
        backLabel="Dashboard"
        icon={Gauge}
        titleTestId="text-scoring-title"
        className="mb-6"
        actions={
          <Button
            variant="outline"
            onClick={() => recomputeMutation.mutate()}
            disabled={recomputeMutation.isPending}
            data-testid="button-recompute-now"
          >
            {recomputeMutation.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            Recompute now
          </Button>
        }
      />

      {configQuery.isLoading ? (
        <div className="flex items-center justify-center py-24 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading scoring config…
        </div>
      ) : configQuery.isError || !config ? (
        <div
          className="border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive"
          data-testid="text-scoring-error"
        >
          Couldn't load the scoring config. Refresh to try again.
        </div>
      ) : (
        <div className="space-y-6">
          <Card data-testid="card-scoring-config">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Score range & status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex flex-wrap items-end gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="score-min">Range min</Label>
                  <Input
                    id="score-min"
                    type="number"
                    min={SCORE_RANGE_MIN}
                    max={SCORE_RANGE_MAX}
                    className="h-9 w-28"
                    value={min}
                    onChange={(e) => setRangeDraft({ min: e.target.value, max })}
                    data-testid="input-score-min"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="score-max">Range max</Label>
                  <Input
                    id="score-max"
                    type="number"
                    min={SCORE_RANGE_MIN}
                    max={SCORE_RANGE_MAX}
                    className="h-9 w-28"
                    value={max}
                    onChange={(e) => setRangeDraft({ min, max: e.target.value })}
                    data-testid="input-score-max"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    configMutation.mutate({ scoreMin: Number(min), scoreMax: Number(max) })
                  }
                  disabled={!rangeDirty || configMutation.isPending}
                  data-testid="button-save-range"
                >
                  {configMutation.isPending ? "Saving…" : "Save range"}
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <Switch
                    checked={config.isEnabled}
                    onCheckedChange={(checked) => configMutation.mutate({ isEnabled: checked })}
                    disabled={configMutation.isPending}
                    data-testid="switch-scoring-enabled"
                  />
                  <span className="text-sm">
                    {config.isEnabled ? "Scoring enabled" : "Scoring paused"}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Final score = fit points + engagement points, clamped to this
                range. Pausing freezes existing scores (nightly sweep and
                event bumps skip).
              </p>
              <div
                className="border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="text-sweep-status"
              >
                {sweep?.status?.startedAt ? (
                  <>
                    Last sweep {formatDateTime(sweep.status.startedAt)} ·{" "}
                    {sweep.status.recordsScored ?? 0} scored ·{" "}
                    {sweep.status.rowsWritten ?? 0} updated
                    {(sweep.status.errors?.length ?? 0) > 0 && (
                      <span className="text-destructive">
                        {" "}
                        · {sweep.status.errors!.length} error(s)
                      </span>
                    )}
                  </>
                ) : (
                  <>No sweep has run yet — scores recompute nightly and on config changes.</>
                )}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-scoring-rules">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-base">
                  Point rules{" "}
                  <span className="font-normal text-muted-foreground">
                    ({rules.length}/{payload?.maxRules ?? 50})
                  </span>
                </CardTitle>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditingRule(null);
                    setRuleDialogOpen(true);
                  }}
                  disabled={atRuleCap}
                  data-testid="button-new-rule"
                >
                  <Plus className="mr-1.5 h-4 w-4" /> New rule
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {rules.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-rules">
                  No rules yet — deals stay unscored until you add point
                  rules. Fit rules award points from record properties;
                  engagement rules award points from recent activity.
                </p>
              ) : (
                <ul className="divide-y" data-testid="list-score-rules">
                  {rules.map((rule) => (
                    <li
                      key={rule.id}
                      className="flex items-center gap-3 py-2.5"
                      data-testid={`row-rule-${rule.id}`}
                    >
                      <Badge variant={rule.kind === "fit" ? "secondary" : "outline"}>
                        {rule.kind === "fit" ? "Fit" : "Engagement"}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{rule.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {ruleSummary(rule)}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-semibold tabular-nums ${
                          rule.points < 0 ? "text-destructive" : "text-emerald-600"
                        }`}
                        data-testid={`points-rule-${rule.id}`}
                      >
                        {rule.points > 0 ? `+${rule.points}` : rule.points}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => {
                            setEditingRule(rule);
                            setRuleDialogOpen(true);
                          }}
                          data-testid={`button-edit-rule-${rule.id}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground"
                          onClick={() => setDeletingRule(rule)}
                          data-testid={`button-delete-rule-${rule.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <PreviewCard />
        </div>
      )}

      <RuleDialog
        open={ruleDialogOpen}
        onOpenChange={(open) => {
          setRuleDialogOpen(open);
          if (!open) setEditingRule(null);
        }}
        existing={editingRule}
        onSaved={afterScoresChanged}
      />

      <AlertDialog open={deletingRule !== null} onOpenChange={(open) => !open && setDeletingRule(null)}>
        <AlertDialogContent data-testid="dialog-delete-rule">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingRule?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Scores recompute immediately without this rule.
              {rules.length === 1
                ? " This is the last rule — deleting it clears every deal score."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingRule && deleteMutation.mutate(deletingRule.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Rule dialog ──────────────────────────────────────────────────────────────

function RuleDialog({
  open,
  onOpenChange,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: ScoreRule | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [kind, setKind] = useState<"fit" | "engagement">("fit");
  const [name, setName] = useState("");
  const [points, setPoints] = useState("10");
  const [criteria, setCriteria] = useState<CriteriaSet>(() => emptyCriteria("deal"));
  const [eventType, setEventType] = useState<EngagementEventType>("email");
  const [direction, setDirection] = useState<EngagementDirection>("any");
  const [windowDays, setWindowDays] = useState("14");
  const [minCount, setMinCount] = useState("1");

  // Re-sync form state each time the dialog opens on a different rule.
  const [syncedFor, setSyncedFor] = useState<string | null>(null);
  const syncKey = existing ? `${existing.id}:${existing.updatedAt}` : "new";
  if (open && syncedFor !== syncKey) {
    setSyncedFor(syncKey);
    setKind(existing?.kind ?? "fit");
    setName(existing?.name ?? "");
    setPoints(existing ? String(existing.points) : "10");
    setCriteria((existing?.criteria as CriteriaSet | null) ?? emptyCriteria("deal"));
    setEventType((existing?.eventType as EngagementEventType | null) ?? "email");
    setDirection((existing?.direction as EngagementDirection | null) ?? "any");
    setWindowDays(existing?.windowDays ? String(existing.windowDays) : "14");
    setMinCount(existing?.minCount ? String(existing.minCount) : "1");
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pts = Number(points);
      if (existing) {
        const body: Record<string, unknown> = { name: name.trim(), points: pts };
        if (existing.kind === "fit") {
          body.criteria = criteria;
        } else {
          body.eventType = eventType;
          body.direction = eventType === "meeting" ? "any" : direction;
          body.windowDays = Number(windowDays);
          body.minCount = Number(minCount);
        }
        const res = await apiRequest("PATCH", `/api/scoring/rules/${existing.id}`, body);
        return res.json();
      }
      const body =
        kind === "fit"
          ? { kind, name: name.trim(), points: pts, criteria }
          : {
              kind,
              name: name.trim(),
              points: pts,
              eventType,
              direction: eventType === "meeting" ? "any" : direction,
              windowDays: Number(windowDays),
              minCount: Number(minCount),
            };
      const res = await apiRequest("POST", "/api/scoring/deal/rules", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: existing ? "Rule updated" : "Rule created", description: "Scores recomputed." });
      onOpenChange(false);
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Couldn't save rule", description: error.message, variant: "destructive" });
    },
  });

  const effectiveKind = existing?.kind ?? kind;
  const pointsValid =
    points.trim() !== "" &&
    Number.isInteger(Number(points)) &&
    Number(points) !== 0 &&
    Number(points) >= SCORE_POINTS_MIN &&
    Number(points) <= SCORE_POINTS_MAX;
  const canSave = name.trim() !== "" && pointsValid && !saveMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="dialog-score-rule">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit rule" : "New rule"}</DialogTitle>
          <DialogDescription>
            {effectiveKind === "fit"
              ? "Award points when a deal's properties match the criteria."
              : "Award points when a deal's client has enough recent activity."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Rule type</Label>
              <Select
                value={effectiveKind}
                onValueChange={(v) => setKind(v as "fit" | "engagement")}
                disabled={existing !== null}
              >
                <SelectTrigger className="h-9" data-testid="select-rule-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fit">Fit (record properties)</SelectItem>
                  <SelectItem value="engagement">Engagement (recent activity)</SelectItem>
                </SelectContent>
              </Select>
              {existing && (
                <p className="text-xs text-muted-foreground">
                  Type is fixed — delete and recreate to switch.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rule-points">Points (+/-)</Label>
              <Input
                id="rule-points"
                type="number"
                min={SCORE_POINTS_MIN}
                max={SCORE_POINTS_MAX}
                step="1"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                data-testid="input-rule-points"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Name *</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                effectiveKind === "fit" ? "e.g. High-value PI deal" : "e.g. Recent inbound email"
              }
              maxLength={120}
              data-testid="input-rule-name"
            />
          </div>

          {effectiveKind === "fit" ? (
            <CriteriaBuilder entityType="deal" value={criteria} onChange={setCriteria} />
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Activity</Label>
                <Select
                  value={eventType}
                  onValueChange={(v) => {
                    const next = v as EngagementEventType;
                    setEventType(next);
                    if (next === "meeting") setDirection("any");
                  }}
                >
                  <SelectTrigger className="h-9" data-testid="select-event-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {engagementEventTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {engagementEventTypeLabels[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Direction</Label>
                <Select
                  value={eventType === "meeting" ? "any" : direction}
                  onValueChange={(v) => setDirection(v as EngagementDirection)}
                  disabled={eventType === "meeting"}
                >
                  <SelectTrigger className="h-9" data-testid="select-direction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {engagementDirections.map((d) => (
                      <SelectItem key={d} value={d}>
                        {engagementDirectionLabels[d]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {eventType === "meeting" && (
                  <p className="text-xs text-muted-foreground">Meetings have no direction.</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-window">Within last (days)</Label>
                <Input
                  id="rule-window"
                  type="number"
                  min={ENGAGEMENT_WINDOW_MIN_DAYS}
                  max={ENGAGEMENT_WINDOW_MAX_DAYS}
                  step="1"
                  value={windowDays}
                  onChange={(e) => setWindowDays(e.target.value)}
                  data-testid="input-window-days"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-min-count">Minimum events</Label>
                <Input
                  id="rule-min-count"
                  type="number"
                  min={ENGAGEMENT_MIN_COUNT_MIN}
                  max={ENGAGEMENT_MIN_COUNT_MAX}
                  step="1"
                  value={minCount}
                  onChange={(e) => setMinCount(e.target.value)}
                  data-testid="input-min-count"
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-rule-cancel">
            Cancel
          </Button>
          <Button onClick={() => saveMutation.mutate()} disabled={!canSave} data-testid="button-rule-save">
            {saveMutation.isPending ? "Saving…" : existing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Sample preview ───────────────────────────────────────────────────────────

function PreviewCard() {
  const { toast } = useToast();
  const [dealId, setDealId] = useState<string>("");
  const [result, setResult] = useState<{
    computed: PreviewComputed | null;
    ruleCount: number;
  } | null>(null);

  const dealsQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ["/api/deals"],
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/scoring/preview", {
        entityType: "deal",
        entityId: dealId,
      });
      return res.json() as Promise<{
        found: boolean;
        computed: PreviewComputed | null;
        ruleCount: number;
      }>;
    },
    onSuccess: (data) => {
      setResult({ computed: data.computed, ruleCount: data.ruleCount });
    },
    onError: (error: Error) => {
      toast({ title: "Preview failed", description: error.message, variant: "destructive" });
    },
  });

  const computed = result?.computed ?? null;

  return (
    <Card data-testid="card-score-preview">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Preview a deal's score</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={dealId} onValueChange={setDealId}>
            <SelectTrigger className="h-9 w-72" data-testid="select-preview-deal">
              <SelectValue placeholder="Pick a deal…" />
            </SelectTrigger>
            <SelectContent>
              {(dealsQuery.data ?? []).map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            onClick={() => previewMutation.mutate()}
            disabled={dealId === "" || previewMutation.isPending}
            data-testid="button-run-preview"
          >
            {previewMutation.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : null}
            Preview score
          </Button>
        </div>

        {result && computed && (
          <div className="space-y-2 border p-3" data-testid="panel-preview-result">
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums" data-testid="text-preview-score">
                {computed.score}
              </span>
              <span className="text-xs text-muted-foreground">
                Fit {computed.fitScore} · Engagement {computed.engagementScore} ·{" "}
                {result.ruleCount} rule(s) evaluated
              </span>
            </div>
            {computed.breakdown.length === 0 ? (
              <p className="text-xs text-muted-foreground">No rules matched this deal.</p>
            ) : (
              <ul className="space-y-1" data-testid="list-preview-breakdown">
                {computed.breakdown.map((entry) => (
                  <li key={entry.ruleId} className="flex items-start justify-between gap-2 text-xs">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{entry.name}</span>
                      {entry.detail && (
                        <span className="block text-muted-foreground">{entry.detail}</span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 font-semibold tabular-nums ${
                        entry.points < 0 ? "text-destructive" : "text-emerald-600"
                      }`}
                    >
                      {entry.points > 0 ? `+${entry.points}` : entry.points}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
