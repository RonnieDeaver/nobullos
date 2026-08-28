import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Tags as TagsIcon,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { TagChip, tagTextColor } from "@/components/tags/TagChip";
import {
  type CriteriaEntityType,
  type CriteriaSet,
} from "@shared/criteria";
import { CriteriaBuilder, emptyCriteria } from "@/components/criteria/CriteriaBuilder";
import { tagColorPalette, type Segment, type Tag } from "@shared/schema";
import { PageHeader } from "@/components/admin/PageHeader";

/**
 * Task #4329 — Tags & Segments management surface (team_lead+).
 * Three tabs: tag definitions, segment definitions, and the sweep status
 * board (kill switch, cadence, queue depth, per-definition freshness).
 */

type TagWithCount = Tag & { taggedCount: number };

interface StatusPayload {
  sweepEnabled: boolean;
  enabledSetting: string;
  intervalMs: number | null;
  isDeployment: boolean;
  forceEnabled: boolean;
  lastSweep: {
    startedAt?: string;
    durationMs?: number;
    tagsEvaluated?: number;
    segmentsEvaluated?: number;
    tagRowsAdded?: number;
    tagRowsRemoved?: number;
    membersAdded?: number;
    membersRemoved?: number;
    orphansPruned?: number;
    errors?: string[];
  } | null;
  queue: {
    pending: number;
    processing: number;
    lastFinished: {
      status: string;
      createdAt: string | null;
      completedAt: string | null;
      errorMessage: string | null;
    } | null;
  };
  definitions: Array<{
    kind: "tag" | "segment";
    id: string;
    name: string;
    entityType: string;
    hasCriteria: boolean;
    lastEvaluatedAt: string | null;
    count: number;
  }>;
}

interface MembersPayload {
  segment: Segment;
  members: Array<{
    entityId: string;
    name: string;
    detail: string | null;
    clientId: string | null;
    addedAt: string | null;
  }>;
  total: number;
  limit: number;
}

const TAGS_KEY = ["/api/tags"] as const;
const SEGMENTS_KEY = ["/api/segments"] as const;
const STATUS_KEY = ["/api/tags-segments/status"] as const;

// Other surfaces (Dashboard's client tag picker, DealsBoard's deal tag
// picker) cache tag lists under entityType/includeAssignments query strings,
// e.g. "/api/tags?entityType=deal&includeAssignments=1". Those are distinct
// query keys from the bare "/api/tags" used on this page, so an exact-key
// invalidation here never reaches them — a predicate on the URL prefix does.
function invalidateAllTagQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/tags"),
  });
}

function formatWhen(value: string | Date | null | undefined): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString();
}

function extractError(err: Error): string {
  // apiRequest throws "STATUS: body" — surface the body when it's JSON.
  const m = /^\d{3}: (.*)$/s.exec(err.message);
  if (!m) return err.message;
  try {
    const parsed = JSON.parse(m[1]);
    if (typeof parsed.error === "string") return parsed.error;
    if (Array.isArray(parsed.error)) {
      return parsed.error
        .map((i: any) => (typeof i === "string" ? i : i.message ?? JSON.stringify(i)))
        .join("; ");
    }
  } catch {
    /* raw body */
  }
  return m[1];
}
function TagDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: TagWithCount | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? tagColorPalette[0]);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [entityType, setEntityType] = useState<"deal" | "client">(
    existing?.entityType ?? "deal",
  );
  const [ruleEnabled, setRuleEnabled] = useState(existing?.criteria != null);
  const [criteria, setCriteria] = useState<CriteriaSet>(
    (existing?.criteria as CriteriaSet | null) ?? emptyCriteria(existing?.entityType ?? "deal"),
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        color,
        description: description.trim() || null,
        criteria: ruleEnabled ? criteria : null,
        ...(existing ? {} : { entityType }),
      };
      const res = existing
        ? await apiRequest("PATCH", `/api/tags/${existing.id}`, body)
        : await apiRequest("POST", "/api/tags", body);
      return res.json();
    },
    onSuccess: () => {
      invalidateAllTagQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
      onOpenChange(false);
      toast({ title: existing ? "Tag updated" : "Tag created" });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't save tag",
        description: extractError(err),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit tag" : "New tag"}</DialogTitle>
          <DialogDescription>
            Colored label for {existing?.entityType ?? entityType}s. Add criteria to
            auto-apply it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tag-name">Name</Label>
              <Input
                id="tag-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Large deal"
                data-testid="input-tag-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Applies to</Label>
              <Select
                value={entityType}
                onValueChange={(v) => {
                  setEntityType(v as "deal" | "client");
                  setCriteria(emptyCriteria(v as CriteriaEntityType));
                }}
                disabled={!!existing}
              >
                <SelectTrigger data-testid="select-tag-entity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deal">Deals</SelectItem>
                  <SelectItem value="client">Clients</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {tagColorPalette.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  className={`h-6 w-6 rounded-full border-2 ${color === hex ? "border-foreground" : "border-transparent"}`}
                  style={{ backgroundColor: hex }}
                  onClick={() => setColor(hex)}
                  aria-label={`Color ${hex}`}
                  data-testid={`swatch-${hex.slice(1)}`}
                />
              ))}
              <Input
                className="h-8 w-24 font-mono text-xs"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                data-testid="input-tag-color"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tag-description">Description (optional)</Label>
            <Textarea
              id="tag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="input-tag-description"
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch
              checked={ruleEnabled}
              onCheckedChange={(checked) => {
                setRuleEnabled(checked);
                if (checked && criteria.groups.length === 0) {
                  setCriteria(emptyCriteria(existing?.entityType ?? entityType));
                }
              }}
              id="tag-rule-enabled"
              data-testid="switch-tag-rule"
            />
            <Label htmlFor="tag-rule-enabled" className="flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              Auto-apply by rule
            </Label>
          </div>

          {ruleEnabled && (
            <CriteriaBuilder
              entityType={existing?.entityType ?? entityType}
              value={criteria}
              onChange={setCriteria}
            />
          )}

          {ruleEnabled && (
            <p className="text-xs text-muted-foreground">
              The tag applies to matching {existing?.entityType ?? entityType}s and
              removes itself when they stop matching. Manually applied chips are
              never touched by the rule.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || name.trim().length === 0}
            data-testid="button-save-tag"
          >
            {saveMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {existing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Segment dialog ───────────────────────────────────────────────────────────

function SegmentDialog({
  open,
  onOpenChange,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: Segment | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [entityType, setEntityType] = useState<"client" | "contact">(
    existing?.entityType ?? "client",
  );
  const [criteria, setCriteria] = useState<CriteriaSet>(
    (existing?.criteria as CriteriaSet | null) ?? emptyCriteria(existing?.entityType ?? "client"),
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        criteria,
        ...(existing ? {} : { entityType }),
      };
      const res = existing
        ? await apiRequest("PATCH", `/api/segments/${existing.id}`, body)
        : await apiRequest("POST", "/api/segments", body);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...SEGMENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
      if (existing) {
        // A still-open Members dialog for this segment would otherwise show
        // membership from before the criteria change.
        void queryClient.invalidateQueries({ queryKey: [`/api/segments/${existing.id}/members`] });
      }
      onOpenChange(false);
      toast({ title: existing ? "Segment updated" : "Segment created" });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't save segment",
        description: extractError(err),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit segment" : "New segment"}</DialogTitle>
          <DialogDescription>
            A saved list whose membership updates automatically as records change.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="segment-name">Name</Label>
              <Input
                id="segment-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="PI firms in onboarding"
                data-testid="input-segment-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Over</Label>
              <Select
                value={entityType}
                onValueChange={(v) => {
                  setEntityType(v as "client" | "contact");
                  setCriteria(emptyCriteria(v as CriteriaEntityType));
                }}
                disabled={!!existing}
              >
                <SelectTrigger data-testid="select-segment-entity-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">Clients</SelectItem>
                  <SelectItem value="contact">Contacts</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="segment-description">Description (optional)</Label>
            <Textarea
              id="segment-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              data-testid="input-segment-description"
            />
          </div>

          <CriteriaBuilder
            entityType={existing?.entityType ?? entityType}
            value={criteria}
            onChange={setCriteria}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || name.trim().length === 0}
            data-testid="button-save-segment"
          >
            {saveMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {existing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Members dialog ───────────────────────────────────────────────────────────

function SegmentMembersDialog({
  segmentId,
  onOpenChange,
}: {
  segmentId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const membersQuery = useQuery<MembersPayload>({
    queryKey: [`/api/segments/${segmentId}/members`],
    enabled: segmentId !== null,
  });
  const data = membersQuery.data;
  return (
    <Dialog open={segmentId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {data ? `${data.segment.name} — ${data.total} member${data.total === 1 ? "" : "s"}` : "Members"}
          </DialogTitle>
          {data && data.total > data.limit && (
            <DialogDescription>Showing the first {data.limit}.</DialogDescription>
          )}
        </DialogHeader>
        {membersQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
          </div>
        ) : membersQuery.isError ? (
          <div className="flex flex-col items-center gap-2 py-6 text-sm text-destructive" data-testid="text-members-error">
            <p>Couldn't load members.</p>
            <Button variant="outline" size="sm" onClick={() => void membersQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (data?.members.length ?? 0) === 0 ? (
          <p className="py-6 text-sm text-muted-foreground" data-testid="text-no-members">
            No members match this segment right now.
          </p>
        ) : (
          <ul className="divide-y" data-testid="list-segment-members">
            {data!.members.map((m) => (
              <li key={m.entityId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.name}</div>
                  {m.detail && (
                    <div className="truncate text-xs text-muted-foreground">{m.detail}</div>
                  )}
                </div>
                {m.clientId && (
                  <a
                    className="shrink-0 text-xs text-primary-ink hover:underline"
                    href={`/clients/${m.clientId}`}
                  >
                    Open
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TagsSegments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const tagsQuery = useQuery<{ tags: TagWithCount[] }>({ queryKey: [...TAGS_KEY] });
  const segmentsQuery = useQuery<Segment[]>({ queryKey: [...SEGMENTS_KEY] });
  const statusQuery = useQuery<StatusPayload>({ queryKey: [...STATUS_KEY] });

  const [tagDialog, setTagDialog] = useState<{ open: boolean; tag: TagWithCount | null }>({
    open: false,
    tag: null,
  });
  const [segmentDialog, setSegmentDialog] = useState<{ open: boolean; segment: Segment | null }>(
    { open: false, segment: null },
  );
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "tag"; id: string; name: string }
    | { kind: "segment"; id: string; name: string }
    | null
  >(null);
  const [membersFor, setMembersFor] = useState<string | null>(null);

  const deleteMutation = useMutation({
    mutationFn: async (target: { kind: "tag" | "segment"; id: string }) => {
      await apiRequest(
        "DELETE",
        target.kind === "tag" ? `/api/tags/${target.id}` : `/api/segments/${target.id}`,
      );
    },
    onSuccess: (_data, target) => {
      if (target.kind === "tag") {
        invalidateAllTagQueries(queryClient);
      }
      void queryClient.invalidateQueries({ queryKey: [...SEGMENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
      setDeleteTarget(null);
      toast({ title: target.kind === "tag" ? "Tag deleted" : "Segment deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: extractError(err), variant: "destructive" });
    },
  });

  const recomputeMutation = useMutation({
    mutationFn: (segmentId: string) =>
      apiRequest("POST", `/api/segments/${segmentId}/recompute`).then((r) => r.json()),
    onSuccess: (result: { memberCount: number }, segmentId) => {
      void queryClient.invalidateQueries({ queryKey: [...SEGMENTS_KEY] });
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
      // If the Members dialog for this segment is already open, its list is
      // now stale too — the count on the row would update but the dialog
      // wouldn't until it happened to be reopened.
      void queryClient.invalidateQueries({ queryKey: [`/api/segments/${segmentId}/members`] });
      toast({ title: `Recomputed — ${result.memberCount} member${result.memberCount === 1 ? "" : "s"}` });
    },
    onError: (err: Error) => {
      toast({ title: "Recompute failed", description: extractError(err), variant: "destructive" });
    },
  });

  const sweepMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tags-segments/sweep").then((r) => r.json()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
      toast({
        title: "Sweep queued",
        description: "The reconciliation job will run on the work queue shortly.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't queue sweep", description: extractError(err), variant: "destructive" });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; intervalMs?: number }) =>
      apiRequest("PATCH", "/api/tags-segments/settings", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't update settings", description: extractError(err), variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: [...STATUS_KEY] });
    },
  });

  const tags = tagsQuery.data?.tags ?? [];
  const segments = segmentsQuery.data ?? [];
  const status = statusQuery.data;
  const forbidden =
    (tagsQuery.error as Error | null)?.message.startsWith("403") ?? false;

  if (forbidden) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Tags & Segments management requires team lead access.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6" data-testid="page-tags-segments">
      <PageHeader
        title="Tags & Segments"
        icon={TagsIcon}
        backHref="/"
        backLabel="Dashboard"
      />

      <Tabs defaultValue="tags">
        <TabsList data-testid="tabs-tags-segments">
          <TabsTrigger value="tags" data-testid="tab-tags">Tags</TabsTrigger>
          <TabsTrigger value="segments" data-testid="tab-segments">Segments</TabsTrigger>
          <TabsTrigger value="status" data-testid="tab-status">Sweep status</TabsTrigger>
        </TabsList>

        {/* ── Tags ── */}
        <TabsContent value="tags" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Colored labels for deals and clients. Rule tags apply themselves.
            </p>
            <Button
              size="sm"
              onClick={() => setTagDialog({ open: true, tag: null })}
              data-testid="button-new-tag"
            >
              <Plus className="mr-1.5 h-4 w-4" /> New tag
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              {tagsQuery.isLoading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : tagsQuery.isError ? (
                <div className="flex flex-col items-center gap-2 p-6 text-sm text-destructive" data-testid="text-tags-error">
                  <p>Couldn't load tags.</p>
                  <Button variant="outline" size="sm" onClick={() => void tagsQuery.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : tags.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground" data-testid="text-no-tag-defs">
                  No tags yet. Create one to start labeling deals and clients.
                </p>
              ) : (
                <table className="w-full text-sm" data-testid="table-tags">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="p-3 font-medium">Tag</th>
                      <th className="p-3 font-medium">Applies to</th>
                      <th className="p-3 font-medium">Mode</th>
                      <th className="p-3 text-right font-medium">Tagged</th>
                      <th className="hidden p-3 font-medium md:table-cell">Last evaluated</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {tags.map((tag) => (
                      <tr key={tag.id} className="border-b last:border-0" data-testid={`row-tag-${tag.id}`}>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <TagChip tag={tag} />
                          </div>
                          {tag.description && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{tag.description}</div>
                          )}
                        </td>
                        <td className="p-3 capitalize">{tag.entityType}s</td>
                        <td className="p-3">
                          {tag.criteria ? (
                            <span className="inline-flex items-center gap-1 text-xs">
                              <Zap className="h-3 w-3" /> Rule
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Manual</span>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums" data-testid={`count-tag-${tag.id}`}>
                          {tag.taggedCount}
                        </td>
                        <td className="hidden p-3 text-xs text-muted-foreground md:table-cell">
                          {tag.criteria ? formatWhen(tag.lastEvaluatedAt) : "—"}
                        </td>
                        <td className="p-3">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setTagDialog({ open: true, tag })}
                              data-testid={`button-edit-tag-${tag.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() => setDeleteTarget({ kind: "tag", id: tag.id, name: tag.name })}
                              data-testid={`button-delete-tag-${tag.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Segments ── */}
        <TabsContent value="segments" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Saved lists over clients and contacts. Membership re-evaluates as records change.
            </p>
            <Button
              size="sm"
              onClick={() => setSegmentDialog({ open: true, segment: null })}
              data-testid="button-new-segment"
            >
              <Plus className="mr-1.5 h-4 w-4" /> New segment
            </Button>
          </div>
          <Card>
            <CardContent className="p-0">
              {segmentsQuery.isLoading ? (
                <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : segmentsQuery.isError ? (
                <div className="flex flex-col items-center gap-2 p-6 text-sm text-destructive" data-testid="text-segments-error">
                  <p>Couldn't load segments.</p>
                  <Button variant="outline" size="sm" onClick={() => void segmentsQuery.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : segments.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground" data-testid="text-no-segments">
                  No segments yet.
                </p>
              ) : (
                <table className="w-full text-sm" data-testid="table-segments">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="p-3 font-medium">Segment</th>
                      <th className="p-3 font-medium">Over</th>
                      <th className="p-3 text-right font-medium">Members</th>
                      <th className="hidden p-3 font-medium md:table-cell">Last evaluated</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((segment) => (
                      <tr key={segment.id} className="border-b last:border-0" data-testid={`row-segment-${segment.id}`}>
                        <td className="p-3">
                          <div className="font-medium">{segment.name}</div>
                          {segment.description && (
                            <div className="mt-0.5 text-xs text-muted-foreground">{segment.description}</div>
                          )}
                        </td>
                        <td className="p-3 capitalize">{segment.entityType}s</td>
                        <td className="p-3 text-right tabular-nums" data-testid={`count-segment-${segment.id}`}>
                          <button
                            type="button"
                            className="underline-offset-2 hover:underline"
                            onClick={() => setMembersFor(segment.id)}
                            data-testid={`button-members-${segment.id}`}
                          >
                            {segment.memberCount}
                          </button>
                        </td>
                        <td className="hidden p-3 text-xs text-muted-foreground md:table-cell">
                          {formatWhen(segment.lastEvaluatedAt)}
                        </td>
                        <td className="p-3">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="View members"
                              onClick={() => setMembersFor(segment.id)}
                              data-testid={`button-view-members-${segment.id}`}
                            >
                              <Users className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Recompute now"
                              disabled={recomputeMutation.isPending}
                              onClick={() => recomputeMutation.mutate(segment.id)}
                              data-testid={`button-recompute-${segment.id}`}
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setSegmentDialog({ open: true, segment })}
                              data-testid={`button-edit-segment-${segment.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              onClick={() =>
                                setDeleteTarget({ kind: "segment", id: segment.id, name: segment.name })
                              }
                              data-testid={`button-delete-segment-${segment.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Status ── */}
        <TabsContent value="status" className="space-y-3">
          {statusQuery.isError && (
            <Card data-testid="card-status-error">
              <CardContent className="flex flex-col items-center gap-2 p-6 text-sm text-destructive">
                <p>
                  Couldn't load sweep status — the controls below may be showing stale or
                  default values, not the real state.
                </p>
                <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card data-testid="card-sweep-controls">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Reconciliation sweep</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">Periodic sweep</div>
                    <p className="text-xs text-muted-foreground">
                      Re-evaluates every rule tag and segment
                      {status?.intervalMs
                        ? ` every ${Math.round(status.intervalMs / 60000)} min`
                        : " every 15 min"}
                      . Kill switch: <code className="text-caption">{status?.enabledSetting}</code>
                    </p>
                  </div>
                  <Switch
                    checked={status?.sweepEnabled ?? false}
                    disabled={statusQuery.isLoading || statusQuery.isError || settingsMutation.isPending}
                    onCheckedChange={(checked) => settingsMutation.mutate({ enabled: checked })}
                    data-testid="switch-sweep-enabled"
                  />
                </div>
                {!status?.isDeployment && (
                  <p className="bg-muted p-2 text-xs text-muted-foreground">
                    This workspace is not a deployment — the scheduler only runs in
                    production{status?.forceEnabled ? " (force-enable is ON here)" : ""}. Writes
                    still evaluate rules instantly; use "Run sweep now" to reconcile manually.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sweepMutation.isPending}
                    onClick={() => sweepMutation.mutate()}
                    data-testid="button-run-sweep"
                  >
                    {sweepMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="mr-1.5 h-4 w-4" />
                    )}
                    Run sweep now
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Queue: {status?.queue.pending ?? 0} pending, {status?.queue.processing ?? 0} running
                  </span>
                </div>
                {status?.queue.lastFinished && (
                  <p className="text-xs text-muted-foreground">
                    Last job: {status.queue.lastFinished.status} at{" "}
                    {formatWhen(status.queue.lastFinished.completedAt ?? status.queue.lastFinished.createdAt)}
                    {status.queue.lastFinished.errorMessage
                      ? ` — ${status.queue.lastFinished.errorMessage}`
                      : ""}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-last-sweep">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Last sweep</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {status?.lastSweep ? (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                    <dt className="text-muted-foreground">Started</dt>
                    <dd>{formatWhen(status.lastSweep.startedAt)}</dd>
                    <dt className="text-muted-foreground">Duration</dt>
                    <dd>{status.lastSweep.durationMs != null ? `${status.lastSweep.durationMs} ms` : "—"}</dd>
                    <dt className="text-muted-foreground">Tags evaluated</dt>
                    <dd>{status.lastSweep.tagsEvaluated ?? 0}</dd>
                    <dt className="text-muted-foreground">Segments evaluated</dt>
                    <dd>{status.lastSweep.segmentsEvaluated ?? 0}</dd>
                    <dt className="text-muted-foreground">Tag rows +/−</dt>
                    <dd>
                      +{status.lastSweep.tagRowsAdded ?? 0} / −{status.lastSweep.tagRowsRemoved ?? 0}
                    </dd>
                    <dt className="text-muted-foreground">Members +/−</dt>
                    <dd>
                      +{status.lastSweep.membersAdded ?? 0} / −{status.lastSweep.membersRemoved ?? 0}
                    </dd>
                    <dt className="text-muted-foreground">Orphans pruned</dt>
                    <dd>{status.lastSweep.orphansPruned ?? 0}</dd>
                    {(status.lastSweep.errors?.length ?? 0) > 0 && (
                      <>
                        <dt className="text-destructive">Errors</dt>
                        <dd className="text-destructive">{status.lastSweep.errors!.join("; ")}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-xs text-muted-foreground" data-testid="text-no-sweep-yet">
                    No sweep has run yet.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card data-testid="card-definition-freshness">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Definition freshness</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {(status?.definitions.length ?? 0) === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No definitions yet.</p>
              ) : (
                <table className="w-full text-sm" data-testid="table-definition-freshness">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="p-3 font-medium">Definition</th>
                      <th className="p-3 font-medium">Kind</th>
                      <th className="p-3 font-medium">Over</th>
                      <th className="p-3 text-right font-medium">Count</th>
                      <th className="p-3 font-medium">Last evaluated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status!.definitions.map((d) => (
                      <tr key={`${d.kind}-${d.id}`} className="border-b last:border-0">
                        <td className="p-3">{d.name}</td>
                        <td className="p-3 text-xs capitalize">
                          {d.kind === "tag" ? (d.hasCriteria ? "rule tag" : "manual tag") : "segment"}
                        </td>
                        <td className="p-3 text-xs capitalize">{d.entityType}s</td>
                        <td className="p-3 text-right tabular-nums">{d.count}</td>
                        <td className="p-3 text-xs text-muted-foreground">
                          {d.kind === "tag" && !d.hasCriteria ? "—" : formatWhen(d.lastEvaluatedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {tagDialog.open && (
        <TagDialog
          key={tagDialog.tag?.id ?? "new"}
          open={tagDialog.open}
          onOpenChange={(open) => setTagDialog((s) => ({ ...s, open }))}
          existing={tagDialog.tag}
        />
      )}
      {segmentDialog.open && (
        <SegmentDialog
          key={segmentDialog.segment?.id ?? "new"}
          open={segmentDialog.open}
          onOpenChange={(open) => setSegmentDialog((s) => ({ ...s, open }))}
          existing={segmentDialog.segment}
        />
      )}
      <SegmentMembersDialog segmentId={membersFor} onOpenChange={(open) => !open && setMembersFor(null)} />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.kind} "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "tag"
                ? "The tag is removed from every deal/client that carries it. This cannot be undone."
                : "The saved list and its cached membership are removed. Client and contact records are not affected."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
