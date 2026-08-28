import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  History,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/admin/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import {
  clientLifecycleStageLabels,
  clientLifecycleStages,
  dealAutomationActionTypeLabels,
  dealAutomationActionTypes,
  dealAutomationSettablePropertyLabels,
  dealAutomationSettableProperties,
  dealTriggerEventStatuses,
  dealTriggerOutcomeLabels,
  dealTriggerTypeLabels,
  dealTriggerTypes,
  type ClientLifecycleStage,
  type DealAutomationAction,
  type DealAutomationActionResult,
  type DealAutomationActionType,
  type DealAutomationRule,
  type DealAutomationRun,
  type DealAutomationSettableProperty,
  type DealPipeline,
  type DealStage,
  type DealTriggerEvent,
  type DealTriggerOutcome,
  type DealTriggersConfig,
  type DealTriggerType,
} from "@shared/schema";

/**
 * Task #4331 — Deal stage automation management surface (team_lead+).
 *
 * Three blocks: the global kill switch + pending-event status strip, the
 * per-stage rule list (toggle / edit / delete / run stats), and the run
 * history table (filterable to one rule). Rule bodies are validated
 * server-side; this page keeps its own light checks only to disable the
 * save button on obviously-incomplete drafts.
 */

type RuleStats = {
  totalRuns: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
};
type RuleWithStats = DealAutomationRule & { stats: RuleStats };
type StatusPayload = {
  enabled: boolean;
  killSwitchKey: string;
  pendingEvents: number;
  oldestPendingAt: string | null;
};
type PipelineWithStages = DealPipeline & { stages: DealStage[] };
interface UserOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

const RULES_KEY = ["/api/deal-automation/rules"] as const;
const STATUS_KEY = ["/api/deal-automation/status"] as const;

const TEMPLATE_HELP =
  "Templates support {{deal_name}}, {{pipeline_name}}, {{stage_name}}, {{from_stage_name}}, {{client_name}}, {{owner_name}} and {{amount}}.";

function userLabel(u: UserOption): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || u.email || u.id;
}

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString();
}

function extractError(err: Error): string {
  const m = /^\d{3}: (.*)$/s.exec(err.message);
  if (!m) return err.message;
  try {
    const parsed = JSON.parse(m[1]);
    if (typeof parsed.error === "string") return parsed.error;
    if (Array.isArray(parsed.error)) {
      return parsed.error
        .map((i: any) =>
          typeof i === "string" ? i : (i.message ?? JSON.stringify(i)),
        )
        .join("; ");
    }
  } catch {
    /* raw body */
  }
  return m[1];
}

// ── Action drafts (dialog state) ─────────────────────────────────────────────

interface ActionDraft {
  type: DealAutomationActionType;
  target: "owner" | "user";
  userId: string;
  title: string;
  body: string;
  listId: string;
  nameTemplate: string;
  descriptionTemplate: string;
  dueInDays: string;
  property: DealAutomationSettableProperty;
  value: string;
  targetStage: ClientLifecycleStage;
}

function emptyDraft(type: DealAutomationActionType): ActionDraft {
  return {
    type,
    target: "owner",
    userId: "",
    title: "",
    body: "",
    listId: "",
    nameTemplate: "",
    descriptionTemplate: "",
    dueInDays: "",
    property: "notes",
    value: "",
    targetStage: "opportunity",
  };
}

function draftFromAction(a: DealAutomationAction): ActionDraft {
  const d = emptyDraft(a.type);
  switch (a.type) {
    case "notify":
      d.target = a.target;
      d.userId = a.userId ?? "";
      d.title = a.title;
      d.body = a.body ?? "";
      break;
    case "clickup_task":
      d.listId = a.listId;
      d.nameTemplate = a.nameTemplate;
      d.descriptionTemplate = a.descriptionTemplate ?? "";
      d.dueInDays = a.dueInDays != null ? String(a.dueInDays) : "";
      break;
    case "set_property":
      d.property = a.property;
      d.value = String(a.value);
      break;
    case "advance_lifecycle":
      d.targetStage = a.targetStage;
      break;
  }
  return d;
}

/** Returns the API-shaped action, or null when the draft is incomplete. */
function draftToAction(d: ActionDraft): DealAutomationAction | null {
  switch (d.type) {
    case "notify": {
      if (!d.title.trim()) return null;
      if (d.target === "user" && !d.userId) return null;
      return {
        type: "notify",
        target: d.target,
        ...(d.target === "user" ? { userId: d.userId } : {}),
        title: d.title.trim(),
        ...(d.body.trim() ? { body: d.body.trim() } : {}),
      };
    }
    case "clickup_task": {
      if (!d.listId.trim() || !d.nameTemplate.trim()) return null;
      const dueInDays = d.dueInDays.trim() === "" ? undefined : Number(d.dueInDays);
      if (dueInDays !== undefined && (!Number.isInteger(dueInDays) || dueInDays < 0)) {
        return null;
      }
      return {
        type: "clickup_task",
        listId: d.listId.trim(),
        nameTemplate: d.nameTemplate.trim(),
        ...(d.descriptionTemplate.trim()
          ? { descriptionTemplate: d.descriptionTemplate.trim() }
          : {}),
        ...(dueInDays !== undefined ? { dueInDays } : {}),
      };
    }
    case "set_property": {
      if (d.value.trim() === "") return null;
      return {
        type: "set_property",
        property: d.property,
        value: d.property === "amount" ? Number(d.value) : d.value.trim(),
      };
    }
    case "advance_lifecycle":
      return { type: "advance_lifecycle", targetStage: d.targetStage };
  }
}

function summarizeAction(a: DealAutomationAction): string {
  switch (a.type) {
    case "notify":
      return `Notify ${a.target === "owner" ? "deal owner" : "user"}`;
    case "clickup_task":
      return "ClickUp task";
    case "set_property":
      return `Set ${dealAutomationSettablePropertyLabels[a.property] ?? a.property}`;
    case "advance_lifecycle":
      return `Lifecycle → ${clientLifecycleStageLabels[a.targetStage] ?? a.targetStage}`;
  }
}

// ── Action editor row ────────────────────────────────────────────────────────

function ActionEditor({
  draft,
  index,
  count,
  users,
  onChange,
  onRemove,
  onMove,
}: {
  draft: ActionDraft;
  index: number;
  count: number;
  users: UserOption[];
  onChange: (next: ActionDraft) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const set = (patch: Partial<ActionDraft>) => onChange({ ...draft, ...patch });
  return (
    <div
      className="rounded-(--radius-md) border p-3 space-y-2"
      data-testid={`action-editor-${index}`}
    >
      <div className="flex items-center gap-2">
        <Select
          value={draft.type}
          onValueChange={(v) => set({ type: v as DealAutomationActionType })}
        >
          <SelectTrigger className="h-8 w-56" data-testid={`select-action-type-${index}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {dealAutomationActionTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {dealAutomationActionTypeLabels[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={index === 0}
            onClick={() => onMove(-1)}
            aria-label="Move action up"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label="Move action down"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive"
            onClick={onRemove}
            disabled={count <= 1}
            aria-label="Remove action"
            data-testid={`button-remove-action-${index}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {draft.type === "notify" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={draft.target}
              onValueChange={(v) => set({ target: v as "owner" | "user" })}
            >
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Deal owner</SelectItem>
                <SelectItem value="user">Specific user</SelectItem>
              </SelectContent>
            </Select>
            {draft.target === "user" && (
              <Select value={draft.userId} onValueChange={(v) => set({ userId: v })}>
                <SelectTrigger className="h-8 w-56" data-testid={`select-notify-user-${index}`}>
                  <SelectValue placeholder="Pick a user" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {userLabel(u)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <Input
            placeholder="Notification title (templates allowed)"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            data-testid={`input-notify-title-${index}`}
          />
          <Textarea
            placeholder="Body (optional)"
            rows={2}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
          />
        </div>
      )}

      {draft.type === "clickup_task" && (
        <div className="space-y-2">
          <Input
            placeholder="ClickUp list ID"
            value={draft.listId}
            onChange={(e) => set({ listId: e.target.value })}
            data-testid={`input-clickup-list-${index}`}
          />
          <Input
            placeholder="Task name (templates allowed)"
            value={draft.nameTemplate}
            onChange={(e) => set({ nameTemplate: e.target.value })}
            data-testid={`input-clickup-name-${index}`}
          />
          <Textarea
            placeholder="Task description (optional)"
            rows={2}
            value={draft.descriptionTemplate}
            onChange={(e) => set({ descriptionTemplate: e.target.value })}
          />
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Due in</Label>
            <Input
              type="number"
              min={0}
              max={365}
              className="h-8 w-24"
              placeholder="days"
              value={draft.dueInDays}
              onChange={(e) => set({ dueInDays: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">days (blank = no due date)</span>
          </div>
        </div>
      )}

      {draft.type === "set_property" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={draft.property}
            onValueChange={(v) =>
              set({ property: v as DealAutomationSettableProperty, value: "" })
            }
          >
            <SelectTrigger className="h-8 w-48" data-testid={`select-property-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dealAutomationSettableProperties.map((p) => (
                <SelectItem key={p} value={p}>
                  {dealAutomationSettablePropertyLabels[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draft.property === "ownerId" ? (
            <Select value={draft.value} onValueChange={(v) => set({ value: v })}>
              <SelectTrigger className="h-8 w-56" data-testid={`select-property-owner-${index}`}>
                <SelectValue placeholder="Pick a user" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {userLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              className="h-8 w-64"
              type={draft.property === "amount" ? "number" : draft.property === "expectedCloseDate" ? "date" : "text"}
              placeholder={draft.property === "expectedCloseDate" ? "YYYY-MM-DD" : "Value"}
              value={draft.value}
              onChange={(e) => set({ value: e.target.value })}
              data-testid={`input-property-value-${index}`}
            />
          )}
        </div>
      )}

      {draft.type === "advance_lifecycle" && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Advance client to</Label>
          <Select
            value={draft.targetStage}
            onValueChange={(v) => set({ targetStage: v as ClientLifecycleStage })}
          >
            <SelectTrigger className="h-8 w-48" data-testid={`select-lifecycle-${index}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {clientLifecycleStages.map((s) => (
                <SelectItem key={s} value={s}>
                  {clientLifecycleStageLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">(forward-only; skipped if no client)</span>
        </div>
      )}
    </div>
  );
}

// ── Rule dialog ──────────────────────────────────────────────────────────────

function RuleDialog({
  open,
  onOpenChange,
  pipelines,
  users,
  existing,
  defaultStageId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelines: PipelineWithStages[];
  users: UserOption[];
  existing: RuleWithStats | null;
  defaultStageId: string | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const initialPipelineId =
    existing?.pipelineId ??
    pipelines.find((p) => p.stages.some((s) => s.id === defaultStageId))?.id ??
    pipelines[0]?.id ??
    "";
  const [name, setName] = useState(existing?.name ?? "");
  const [pipelineId, setPipelineId] = useState(initialPipelineId);
  const [stageId, setStageId] = useState(existing?.stageId ?? defaultStageId ?? "");
  const [fromStageId, setFromStageId] = useState(existing?.fromStageId ?? "any");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [drafts, setDrafts] = useState<ActionDraft[]>(
    existing && Array.isArray(existing.actions) && existing.actions.length > 0
      ? existing.actions.map(draftFromAction)
      : [emptyDraft("notify")],
  );

  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? null;
  const stages = pipeline?.stages ?? [];
  const actions = drafts.map(draftToAction);
  const actionsValid = actions.every((a) => a !== null) && actions.length >= 1;
  const canSave = name.trim().length > 0 && stageId && actionsValid;

  const save = useMutation({
    mutationFn: async () => {
      const payloadActions = actions as DealAutomationAction[];
      if (existing) {
        const res = await apiRequest(
          "PATCH",
          `/api/deal-automation/rules/${existing.id}`,
          {
            name: name.trim(),
            fromStageId: fromStageId === "any" ? null : fromStageId,
            enabled,
            actions: payloadActions,
          },
        );
        return res.json();
      }
      const res = await apiRequest("POST", "/api/deal-automation/rules", {
        stageId,
        fromStageId: fromStageId === "any" ? null : fromStageId,
        name: name.trim(),
        enabled,
        actions: payloadActions,
      });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RULES_KEY });
      toast({ title: existing ? "Rule updated" : "Rule created" });
      onOpenChange(false);
    },
    onError: (err: Error) =>
      toast({
        title: "Could not save rule",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit automation rule" : "New automation rule"}</DialogTitle>
          <DialogDescription>
            Fires when a deal enters the trigger stage. {TEMPLATE_HELP}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="rule-name">Rule name</Label>
            <Input
              id="rule-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Kickoff tasks on Won"
              data-testid="input-rule-name"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Pipeline</Label>
              <Select
                value={pipelineId}
                onValueChange={(v) => {
                  setPipelineId(v);
                  setStageId("");
                  setFromStageId("any");
                }}
                disabled={Boolean(existing)}
              >
                <SelectTrigger data-testid="select-rule-pipeline">
                  <SelectValue placeholder="Pipeline" />
                </SelectTrigger>
                <SelectContent>
                  {pipelines.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>When deal enters</Label>
              <Select
                value={stageId}
                onValueChange={setStageId}
                disabled={Boolean(existing)}
              >
                <SelectTrigger data-testid="select-rule-stage">
                  <SelectValue placeholder="Trigger stage" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Only when coming from</Label>
              <Select value={fromStageId} onValueChange={setFromStageId}>
                <SelectTrigger data-testid="select-rule-from-stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any stage</SelectItem>
                  {stages
                    .filter((s) => s.id !== stageId)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Actions (run in order)</Label>
              <Button
                size="sm"
                variant="outline"
                disabled={drafts.length >= 10}
                onClick={() => setDrafts((d) => [...d, emptyDraft("notify")])}
                data-testid="button-add-action"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add action
              </Button>
            </div>
            {drafts.map((draft, i) => (
              <ActionEditor
                key={i}
                draft={draft}
                index={i}
                count={drafts.length}
                users={users}
                onChange={(next) =>
                  setDrafts((d) => d.map((x, j) => (j === i ? next : x)))
                }
                onRemove={() => setDrafts((d) => d.filter((_, j) => j !== i))}
                onMove={(delta) =>
                  setDrafts((d) => {
                    const next = [...d];
                    const target = i + delta;
                    if (target < 0 || target >= next.length) return d;
                    [next[i], next[target]] = [next[target], next[i]];
                    return next;
                  })
                }
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Rule enabled"
              data-testid="switch-rule-enabled"
            />
            <span className="text-sm">{enabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
            data-testid="button-save-rule"
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : existing ? (
              "Save changes"
            ) : (
              "Create rule"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Run status badge ─────────────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: string }) {
  const variant =
    status === "succeeded"
      ? "default"
      : status === "failed"
        ? "destructive"
        : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

// ── Native trigger hooks (Task #4332) ────────────────────────────────────────

type TriggerConfigPayload = {
  config: DealTriggersConfig;
  knownPandadocStatuses: string[];
};

type UnlinkedDoc = {
  id: string;
  documentId: string;
  title: string;
  status: string;
  linkedClientId: string | null;
};

type DealOption = { id: string; name: string; clientFirmName?: string | null };

const TRIGGER_CONFIG_KEY = ["/api/deal-automation/triggers/config"] as const;
const UNLINKED_DOCS_KEY = [
  "/api/deal-automation/triggers/pandadoc/unlinked",
] as const;
const TRIGGER_EVENTS_BASE = "/api/deal-automation/triggers/events";

function TriggerEventStatusBadge({ status }: { status: string }) {
  const variant =
    status === "processed"
      ? "default"
      : status === "failed"
        ? "destructive"
        : status === "pending"
          ? "outline"
          : "secondary";
  return (
    <Badge variant={variant} className="capitalize">
      {status}
    </Badge>
  );
}

/**
 * Native trigger hooks: per-hook enable toggles + booking stage / PandaDoc
 * status→stage mapping, the unlinked-document review list, and the trigger
 * event run log. Edits stage locally and persist on an explicit Save so a
 * half-built mapping never goes live row by row.
 */
function NativeTriggersSection({
  pipelines,
}: {
  pipelines: PipelineWithStages[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const configQuery = useQuery<TriggerConfigPayload>({
    queryKey: TRIGGER_CONFIG_KEY,
  });
  const unlinkedQuery = useQuery<UnlinkedDoc[]>({ queryKey: UNLINKED_DOCS_KEY });
  const dealsQuery = useQuery<DealOption[]>({ queryKey: ["/api/deals"] });

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const eventsKey = useMemo(() => {
    const params = new URLSearchParams();
    if (typeFilter !== "all") params.set("type", typeFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    const qs = params.toString();
    return qs ? `${TRIGGER_EVENTS_BASE}?${qs}` : TRIGGER_EVENTS_BASE;
  }, [typeFilter, statusFilter]);
  const eventsQuery = useQuery<DealTriggerEvent[]>({ queryKey: [eventsKey] });

  const invalidateTriggerQueries = () => {
    void queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey[0] === "string" &&
        (q.queryKey[0].startsWith(TRIGGER_EVENTS_BASE) ||
          q.queryKey[0] === UNLINKED_DOCS_KEY[0]),
    });
  };

  // Draft config: null = mirror the server value, non-null = unsaved edits.
  const [draft, setDraft] = useState<DealTriggersConfig | null>(null);
  const config = draft ?? configQuery.data?.config ?? null;
  const knownStatuses = configQuery.data?.knownPandadocStatuses ?? [];
  const edit = (patch: Partial<DealTriggersConfig>) => {
    if (!config) return;
    setDraft({ ...config, ...patch });
  };

  const [addStatus, setAddStatus] = useState<string>("");
  const [addSlug, setAddSlug] = useState<string>("");
  const [linkSelections, setLinkSelections] = useState<Record<string, string>>({});

  const defaultPipeline = useMemo(
    () => pipelines.find((p) => p.isDefault) ?? pipelines[0],
    [pipelines],
  );
  // Memoized so `stages` keeps a stable identity across renders — it feeds
  // the stageNameBySlug useMemo's dependency array below (exhaustive-deps).
  const stages = useMemo(() => defaultPipeline?.stages ?? [], [defaultPipeline]);
  const openStages = stages.filter((s) => s.stageType === "open");
  const stageNameBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stages) map.set(s.slug, s.name);
    return map;
  }, [stages]);

  const saveConfig = useMutation({
    mutationFn: async (next: DealTriggersConfig) => {
      const res = await apiRequest(
        "PUT",
        "/api/deal-automation/triggers/config",
        next,
      );
      return res.json();
    },
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: TRIGGER_CONFIG_KEY });
      void queryClient.invalidateQueries({ queryKey: UNLINKED_DOCS_KEY });
      toast({ title: "Trigger settings saved" });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not save trigger settings",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const linkDoc = useMutation({
    mutationFn: async (input: { docId: string; dealId: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/deal-automation/triggers/pandadoc/${input.docId}/link-deal`,
        { dealId: input.dealId },
      );
      return res.json();
    },
    onSuccess: (data: { reprocessedEvent: DealTriggerEvent | null }) => {
      invalidateTriggerQueries();
      const outcome = data.reprocessedEvent?.outcome;
      toast({
        title: "Document linked",
        description: outcome
          ? `Pending event reprocessed: ${dealTriggerOutcomeLabels[outcome as DealTriggerOutcome] ?? outcome}`
          : "The next status change will move the linked deal.",
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not link document",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const reprocess = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(
        "POST",
        `/api/deal-automation/triggers/events/${id}/reprocess`,
        {},
      );
      return res.json();
    },
    onSuccess: (event: DealTriggerEvent) => {
      invalidateTriggerQueries();
      toast({
        title: "Event reprocessed",
        description: event.outcome
          ? (dealTriggerOutcomeLabels[event.outcome as DealTriggerOutcome] ??
            event.outcome)
          : event.status,
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not reprocess event",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const events = eventsQuery.data ?? [];
  const unlinkedDocs = unlinkedQuery.data ?? [];
  const deals = dealsQuery.data ?? [];
  const mapEntries = config ? Object.entries(config.pandadocStageMap) : [];
  const unmappedStatuses = knownStatuses.filter(
    (s) => !config || !(s in config.pandadocStageMap),
  );

  return (
    <>
      {/* Hook toggles + mappings */}
      <Card data-testid="card-native-triggers">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg flex items-center gap-2">
              <Workflow className="h-5 w-5" /> Native triggers
            </CardTitle>
            <div className="flex items-center gap-2">
              {draft && (
                <>
                  <span className="text-xs text-amber-600">Unsaved changes</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDraft(null)}
                    data-testid="button-discard-trigger-config"
                  >
                    Discard
                  </Button>
                </>
              )}
              <Button
                size="sm"
                onClick={() => draft && saveConfig.mutate(draft)}
                disabled={!draft || saveConfig.isPending}
                data-testid="button-save-trigger-config"
              >
                {saveConfig.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : null}
                Save
              </Button>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Auto-move deals from events NoBull OS already captures. Each hook
            has its own switch; every move lands in the deal's stage history
            with its source event.
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {configQuery.isLoading || !config ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading trigger settings…
            </div>
          ) : (
            <>
              {/* Booking hook */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Switch
                    checked={config.bookingEnabled}
                    onCheckedChange={(v) => edit({ bookingEnabled: v })}
                    aria-label="Enable booking-confirmed trigger"
                    data-testid="switch-trigger-booking"
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-sm">
                      {dealTriggerTypeLabels.booking_confirmed}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      A confirmed session moves the client's open deal to the
                      stage below (forward only — deals already past it stay put).
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Stage</Label>
                    <Select
                      value={config.bookingStageSlug}
                      onValueChange={(v) => edit({ bookingStageSlug: v })}
                    >
                      <SelectTrigger
                        className="w-44 h-8"
                        data-testid="select-booking-stage"
                      >
                        <SelectValue placeholder="Stage" />
                      </SelectTrigger>
                      <SelectContent>
                        {openStages.map((s) => (
                          <SelectItem key={s.id} value={s.slug}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* PandaDoc hook */}
              <div className="space-y-2 border-t pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Switch
                    checked={config.pandadocEnabled}
                    onCheckedChange={(v) => edit({ pandadocEnabled: v })}
                    aria-label="Enable document-status trigger"
                    data-testid="switch-trigger-pandadoc"
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-sm">
                      {dealTriggerTypeLabels.pandadoc_status_changed}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Documents must be linked to a deal; status changes then
                      move the deal per this mapping.
                    </div>
                  </div>
                </div>
                <div className="pl-12 space-y-1.5">
                  {mapEntries.length === 0 && (
                    <div className="text-xs text-muted-foreground" data-testid="text-no-pandadoc-mappings">
                      No status mappings yet — add one below.
                    </div>
                  )}
                  {mapEntries.map(([docStatus, slug]) => (
                    <div
                      key={docStatus}
                      className="flex items-center gap-2 text-sm"
                      data-testid={`row-pandadoc-mapping-${docStatus}`}
                    >
                      <Badge variant="outline" className="capitalize">
                        {docStatus.replace(/^document\./, "")}
                      </Badge>
                      <span className="text-muted-foreground">→</span>
                      <span>{stageNameBySlug.get(slug) ?? slug}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label={`Remove mapping for ${docStatus}`}
                        onClick={() => {
                          const next = { ...config.pandadocStageMap };
                          delete next[docStatus];
                          edit({ pandadocStageMap: next });
                        }}
                        data-testid={`button-remove-mapping-${docStatus}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Select value={addStatus} onValueChange={setAddStatus}>
                      <SelectTrigger
                        className="w-44 h-8"
                        data-testid="select-add-mapping-status"
                      >
                        <SelectValue placeholder="Document status" />
                      </SelectTrigger>
                      <SelectContent>
                        {unmappedStatuses.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.replace(/^document\./, "")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span className="text-muted-foreground text-sm">→</span>
                    <Select value={addSlug} onValueChange={setAddSlug}>
                      <SelectTrigger
                        className="w-44 h-8"
                        data-testid="select-add-mapping-stage"
                      >
                        <SelectValue placeholder="Stage" />
                      </SelectTrigger>
                      <SelectContent>
                        {stages.map((s) => (
                          <SelectItem key={s.id} value={s.slug}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!addStatus || !addSlug}
                      onClick={() => {
                        if (!addStatus || !addSlug) return;
                        edit({
                          pandadocStageMap: {
                            ...config.pandadocStageMap,
                            [addStatus]: addSlug,
                          },
                        });
                        setAddStatus("");
                        setAddSlug("");
                      }}
                      data-testid="button-add-mapping"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add mapping
                    </Button>
                  </div>
                </div>
              </div>

              {/* Front reply hook */}
              <div className="space-y-2 border-t pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Switch
                    checked={config.frontReplyEnabled}
                    onCheckedChange={(v) => edit({ frontReplyEnabled: v })}
                    aria-label="Enable inbound-reply trigger"
                    data-testid="switch-trigger-front-reply"
                  />
                  <div className="min-w-0">
                    <div className="font-medium text-sm">
                      {dealTriggerTypeLabels.front_inbound_reply}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Logs a durable reply-detected event when a matched contact
                      replies (no deal move — sequences will consume these to
                      cancel pending follow-ups).
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Unlinked PandaDoc documents */}
      <Card data-testid="card-unlinked-docs">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Link2 className="h-5 w-5" /> PandaDoc documents awaiting deal link
          </CardTitle>
          <div className="text-xs text-muted-foreground">
            These documents reached a mapped status but aren't linked to a deal,
            so nothing was moved. Link one to apply its pending move.
          </div>
        </CardHeader>
        <CardContent>
          {unlinkedQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading documents…
            </div>
          ) : unlinkedDocs.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-no-unlinked-docs">
              No documents waiting on a link.
            </div>
          ) : (
            <div className="space-y-2">
              {unlinkedDocs.map((doc) => (
                <div
                  key={doc.id}
                  className="rounded-(--radius-md) border p-3 flex flex-wrap items-center gap-3"
                  data-testid={`unlinked-doc-${doc.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm truncate">{doc.title}</div>
                    <div className="text-xs text-muted-foreground capitalize">
                      Status: {doc.status.replace(/^document\./, "")}
                    </div>
                  </div>
                  <Select
                    value={linkSelections[doc.id] ?? ""}
                    onValueChange={(v) =>
                      setLinkSelections((prev) => ({ ...prev, [doc.id]: v }))
                    }
                  >
                    <SelectTrigger
                      className="w-56 h-8"
                      data-testid={`select-link-deal-${doc.id}`}
                    >
                      <SelectValue placeholder="Choose deal…" />
                    </SelectTrigger>
                    <SelectContent>
                      {deals.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                          {d.clientFirmName ? ` — ${d.clientFirmName}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={!linkSelections[doc.id] || linkDoc.isPending}
                    onClick={() =>
                      linkDoc.mutate({
                        docId: doc.id,
                        dealId: linkSelections[doc.id],
                      })
                    }
                    data-testid={`button-link-doc-${doc.id}`}
                  >
                    {linkDoc.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Link2 className="h-3.5 w-3.5 mr-1" />
                    )}
                    Link
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trigger event log */}
      <Card data-testid="card-trigger-events">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Trigger events</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-44 h-8" data-testid="select-event-type-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All triggers</SelectItem>
                  {dealTriggerTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {dealTriggerTypeLabels[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32 h-8" data-testid="select-event-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {dealTriggerEventStatuses.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => eventsQuery.refetch()}
                aria-label="Refresh trigger events"
                data-testid="button-refresh-trigger-events"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {eventsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
            </div>
          ) : events.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-no-trigger-events">
              No trigger events yet. Events appear here when an enabled hook
              observes a booking, document status change, or inbound reply.
            </div>
          ) : (
            <div className="space-y-2">
              {events.map((event) => (
                <div
                  key={event.id}
                  className="rounded-(--radius-md) border p-3 space-y-1"
                  data-testid={`trigger-event-${event.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <TriggerEventStatusBadge status={event.status} />
                    <span className="font-medium">
                      {dealTriggerTypeLabels[event.triggerType as DealTriggerType] ??
                        event.triggerType}
                    </span>
                    {event.outcome && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          {dealTriggerOutcomeLabels[
                            event.outcome as DealTriggerOutcome
                          ] ?? event.outcome}
                        </span>
                      </>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatWhen(event.createdAt)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Source: {event.sourceId}
                    {event.attempts > 1 ? ` · ${event.attempts} attempts` : ""}
                  </div>
                  {event.error && (
                    <div className="text-xs text-destructive">{event.error}</div>
                  )}
                  {(event.status === "failed" || event.status === "skipped") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1"
                      disabled={reprocess.isPending}
                      onClick={() => reprocess.mutate(event.id)}
                      data-testid={`button-reprocess-${event.id}`}
                    >
                      {reprocess.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5 mr-1" />
                      )}
                      Reprocess
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DealAutomation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RuleWithStats | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RuleWithStats | null>(null);
  const [runFilterRuleId, setRunFilterRuleId] = useState<string | null>(null);

  const statusQuery = useQuery<StatusPayload>({ queryKey: STATUS_KEY });
  const rulesQuery = useQuery<RuleWithStats[]>({ queryKey: RULES_KEY });
  const pipelinesQuery = useQuery<PipelineWithStages[]>({
    queryKey: ["/api/deals/pipelines"],
  });
  const usersQuery = useQuery<UserOption[]>({ queryKey: ["/api/users"] });

  const runsKey = runFilterRuleId
    ? `/api/deal-automation/runs?ruleId=${encodeURIComponent(runFilterRuleId)}`
    : "/api/deal-automation/runs";
  const runsQuery = useQuery<DealAutomationRun[]>({ queryKey: [runsKey] });

  const killSwitch = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/deal-automation/kill-switch", {
        enabled,
      });
      return res.json();
    },
    onSuccess: (data: { enabled: boolean }) => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({
        title: data.enabled ? "Automations enabled" : "Automations paused",
        description: data.enabled
          ? "Stage-entry rules will fire again."
          : "New stage moves record skipped runs until re-enabled.",
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Could not update kill switch",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const requeue = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/deal-automation/events/requeue", {});
      return res.json();
    },
    onSuccess: (data: { scanned: number; requeued: number }) => {
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      toast({
        title: "Requeue complete",
        description: `${data.requeued} pending event(s) re-enqueued.`,
      });
    },
    onError: (err: Error) =>
      toast({
        title: "Requeue failed",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const toggleRule = useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) => {
      const res = await apiRequest(
        "PATCH",
        `/api/deal-automation/rules/${input.id}`,
        { enabled: input.enabled },
      );
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RULES_KEY }),
    onError: (err: Error) =>
      toast({
        title: "Could not toggle rule",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/deal-automation/rules/${id}`);
      return res.json();
    },
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: RULES_KEY });
      // The run-history query key embeds the current filter (dynamic
      // "/api/deal-automation/runs" or "...?ruleId=<id>") — invalidate by
      // predicate so a deleted rule's stale runs don't linger in the cache.
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return typeof key === "string" && key.startsWith("/api/deal-automation/runs");
        },
      });
      if (runFilterRuleId === id) setRunFilterRuleId(null);
      toast({ title: "Rule deleted" });
      setDeleting(null);
    },
    onError: (err: Error) =>
      toast({
        title: "Could not delete rule",
        description: extractError(err),
        variant: "destructive",
      }),
  });

  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data]);
  const users = usersQuery.data ?? [];
  const rules = useMemo(() => rulesQuery.data ?? [], [rulesQuery.data]);
  const rulesByStage = useMemo(() => {
    const map = new Map<string, RuleWithStats[]>();
    for (const rule of rules) {
      const list = map.get(rule.stageId) ?? [];
      list.push(rule);
      map.set(rule.stageId, list);
    }
    return map;
  }, [rules]);
  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pipelines) for (const s of p.stages) map.set(s.id, s.name);
    return map;
  }, [pipelines]);

  const status = statusQuery.data;
  const runs = runsQuery.data ?? [];

  return (
    <div className="container mx-auto px-4 py-6 max-w-5xl space-y-6" data-testid="page-deal-automation">
      {/* Task #4661 — shared Pattern-A header (page previously shipped no
          back affordance). */}
      <PageHeader
        title="Deal automations"
        icon={Zap}
        backHref="/"
        backLabel="Dashboard"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setDefaultStageId(null);
              setDialogOpen(true);
            }}
            disabled={pipelines.length === 0}
            data-testid="button-new-rule"
          >
            <Plus className="h-4 w-4 mr-1" /> New rule
          </Button>
        }
      />

      {/* Status / kill switch */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-3">
              <Switch
                checked={status?.enabled ?? true}
                disabled={statusQuery.isLoading || killSwitch.isPending}
                onCheckedChange={(v) => killSwitch.mutate(v)}
                aria-label="Automations global kill switch"
                data-testid="switch-kill-switch"
              />
              <div>
                <div className="font-medium text-sm">
                  {status?.enabled === false ? "Automations paused" : "Automations running"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Global kill switch — pausing records skipped runs instead of executing actions.
                </div>
              </div>
            </div>
            <div className="text-sm text-muted-foreground">
              Pending events:{" "}
              <span className="font-medium text-foreground" data-testid="text-pending-events">
                {status ? status.pendingEvents : "…"}
              </span>
              {status?.oldestPendingAt && (
                <span className="ml-2 text-xs">(oldest {formatWhen(status.oldestPendingAt)})</span>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => requeue.mutate()}
              disabled={requeue.isPending}
              data-testid="button-requeue-events"
            >
              {requeue.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              Requeue stuck events
            </Button>
            {status?.enabled === false && (
              <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs">
                <AlertTriangle className="h-3.5 w-3.5" /> Rules will not fire until re-enabled.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Rules by pipeline/stage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {rulesQuery.isLoading || pipelinesQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading rules…
            </div>
          ) : rules.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-no-rules">
              No automation rules yet. Create one to fire actions when a deal enters a stage.
            </div>
          ) : (
            pipelines.map((p) => {
              const stagesWithRules = p.stages.filter(
                (s) => (rulesByStage.get(s.id) ?? []).length > 0,
              );
              if (stagesWithRules.length === 0) return null;
              return (
                <div key={p.id} className="space-y-4">
                  <div className="text-sm font-medium text-muted-foreground">{p.name}</div>
                  {stagesWithRules.map((s) => (
                    <div key={s.id} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{s.name}</Badge>
                        <span className="text-xs text-muted-foreground">on entry</span>
                      </div>
                      {(rulesByStage.get(s.id) ?? []).map((rule) => (
                        <div
                          key={rule.id}
                          className="rounded-(--radius-md) border p-3 flex flex-wrap items-center gap-3"
                          data-testid={`rule-row-${rule.id}`}
                        >
                          <Switch
                            checked={rule.enabled}
                            disabled={toggleRule.isPending}
                            onCheckedChange={(v) =>
                              toggleRule.mutate({ id: rule.id, enabled: v })
                            }
                            aria-label={`Toggle rule ${rule.name}`}
                            data-testid={`switch-rule-${rule.id}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm truncate">{rule.name}</div>
                            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-2">
                              {rule.fromStageId && (
                                <span>
                                  only from {stageNameById.get(rule.fromStageId) ?? "?"}
                                </span>
                              )}
                              <span>
                                {(Array.isArray(rule.actions) ? rule.actions : [])
                                  .map(summarizeAction)
                                  .join(" · ")}
                              </span>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground text-right">
                            <div>
                              {rule.stats.totalRuns} run{rule.stats.totalRuns === 1 ? "" : "s"}
                            </div>
                            <div>
                              last: {formatWhen(rule.stats.lastRunAt)}{" "}
                              {rule.stats.lastRunStatus && (
                                <span className="capitalize">({rule.stats.lastRunStatus})</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => setRunFilterRuleId(rule.id)}
                              aria-label="View run history"
                              data-testid={`button-rule-runs-${rule.id}`}
                            >
                              <History className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => {
                                setEditing(rule);
                                setDefaultStageId(null);
                                setDialogOpen(true);
                              }}
                              aria-label="Edit rule"
                              data-testid={`button-edit-rule-${rule.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive"
                              onClick={() => setDeleting(rule)}
                              aria-label="Delete rule"
                              data-testid={`button-delete-rule-${rule.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Run history */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-lg">Run history</CardTitle>
            <div className="flex items-center gap-2">
              {runFilterRuleId && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setRunFilterRuleId(null)}
                  data-testid="button-clear-run-filter"
                >
                  Clear filter
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => runsQuery.refetch()}
                aria-label="Refresh runs"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          {runFilterRuleId && (
            <div className="text-xs text-muted-foreground">
              Showing runs for: {rules.find((r) => r.id === runFilterRuleId)?.name ?? runFilterRuleId}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {runsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
            </div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="text-no-runs">
              No runs yet.
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="rounded-(--radius-md) border p-3 space-y-1"
                  data-testid={`run-row-${run.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <RunStatusBadge status={run.status} />
                    <span className="font-medium">{run.ruleName}</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="truncate">{run.dealName}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatWhen(run.startedAt)}
                    </span>
                  </div>
                  {run.skipReason && (
                    <div className="text-xs text-muted-foreground">
                      Skipped: {run.skipReason}
                    </div>
                  )}
                  {run.error && (
                    <div className="text-xs text-destructive">{run.error}</div>
                  )}
                  {Array.isArray(run.actionResults) && run.actionResults.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      {(run.actionResults as DealAutomationActionResult[]).map((r) => (
                        <div key={r.index}>
                          {r.index + 1}. {dealAutomationActionTypeLabels[r.type] ?? r.type} —{" "}
                          <span
                            className={
                              r.status === "failed"
                                ? "text-destructive"
                                : r.status === "succeeded"
                                  ? "text-foreground"
                                  : undefined
                            }
                          >
                            {r.status}
                          </span>
                          {r.detail ? ` (${r.detail})` : ""}
                          {r.error ? ` — ${r.error}` : ""}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <NativeTriggersSection pipelines={pipelines} />

      {dialogOpen && (
        <RuleDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          pipelines={pipelines}
          users={users}
          existing={editing}
          defaultStageId={defaultStageId}
        />
      )}

      <AlertDialog open={Boolean(deleting)} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.name}" and its entire run history will be deleted. Deals already
              processed are unaffected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteRule.mutate(deleting.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-rule"
            >
              {deleteRule.isPending ? "Deleting…" : "Delete rule"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
