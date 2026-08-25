/**
 * Task #4335 — Sequence detail: steps, enrollment, analytics, controls.
 *
 * The operator surface for one sequence:
 *   - steps table (template + delay) with an editor that refuses to change
 *     steps under live enrollments (server 409s; surfaced as a toast);
 *   - manual enrollment (client or contact, sender defaults to the client's
 *     assigned owner) and segment enrollment (capped, per-member outcomes);
 *   - enrollments table with VISIBLE cancel reasons — a reply-cancelled row
 *     says "Replied" right in the status column;
 *   - funnel analytics (enrolled / in progress / replied / completed) and
 *     per-step send counts;
 *   - pause/activate, archive (cancels active enrollments), and the
 *     owner-or-CEO-gated auto-send toggle.
 */
import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/admin/PageHeader";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Archive,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  UserPlus,
  Users,
  XCircle,
} from "lucide-react";
import {
  CANCEL_REASON_LABELS,
  SequenceStepsEditor,
  apiErrorDetail,
  fmtDateTime,
  formatDelay,
  fromDelayMinutes,
  toDelayMinutes,
  type StepDraft,
  type TemplateOption,
} from "@/components/admin/EmailSequenceShared";

// ── Types mirrored from the API ──────────────────────────────────────────────

interface SequenceRow {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  autoSendEnabled: boolean;
  createdBy: string | null;
  createdAt: string;
}

interface StepRow {
  id: string;
  stepOrder: number;
  templateId: string;
  delayMinutes: number;
  aiPersonalizationEnabled: boolean;
  templateName: string;
}

interface PerStepCounts {
  stepOrder: number;
  draft: number;
  approved: number;
  rejected: number;
  cancelled: number;
  suppressed: number;
  renderFailed: number;
}

interface Analytics {
  enrolled: number;
  inProgress: number;
  completed: number;
  replied: number;
  cancelledOther: number;
  perStep: PerStepCounts[];
}

interface DetailPayload {
  sequence: SequenceRow;
  steps: StepRow[];
  analytics: Analytics;
}

interface EnrollmentRow {
  id: string;
  entityType: "client" | "contact";
  entityId: string;
  clientId: string;
  recipientEmail: string;
  senderUserId: string;
  status: "active" | "completed" | "cancelled";
  cancelReason: string | null;
  cancelNote: string | null;
  currentStepOrder: number;
  nextStepAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

interface ClientOption {
  id: string;
  firmName: string;
}

interface ContactOption {
  id: string;
  name: string;
  emails: string[] | null;
}

interface SegmentOption {
  id: string;
  name: string;
}

interface AppUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

function normalizeClients(raw: unknown): ClientOption[] {
  if (Array.isArray(raw)) return raw as ClientOption[];
  if (raw && typeof raw === "object" && Array.isArray((raw as { clients?: unknown }).clients)) {
    return (raw as { clients: ClientOption[] }).clients;
  }
  return [];
}

function userLabel(u: AppUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name || u.email || u.id;
}

const OWNER_SENTINEL = "__owner";

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmailSequenceDetail() {
  const [, params] = useRoute("/admin/email-sequences/:id");
  const sequenceId = params?.id ?? "";
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const detailQ = useQuery<DetailPayload>({
    queryKey: ["/api/email-sequences", sequenceId],
    enabled: !!sequenceId,
  });
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const enrollmentsQ = useQuery<{ enrollments: EnrollmentRow[] }>({
    queryKey: ["/api/email-sequences", sequenceId, "enrollments"],
    enabled: !!sequenceId,
  });
  const templatesQ = useQuery<{ templates: Array<TemplateOption & { archived: boolean }> }>({
    queryKey: ["/api/email-templates"],
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ["/api/email-sequences", sequenceId] });
    void qc.invalidateQueries({ queryKey: ["/api/email-sequences"] });
  };

  const patchMutation = useMutation({
    mutationFn: async (body: { status?: string; name?: string }) => {
      const res = await apiRequest("PATCH", `/api/email-sequences/${sequenceId}`, body);
      return res.json();
    },
    onSuccess: (_d, body) => {
      if (body.status === "active") toast({ title: "Sequence activated" });
      else if (body.status === "paused") toast({ title: "Sequence paused" });
      else if (body.status === "archived")
        toast({ title: "Sequence archived", description: "Active enrollments were cancelled." });
      invalidateAll();
      void qc.invalidateQueries({ queryKey: ["/api/email-sequences", sequenceId, "enrollments"] });
    },
    onError: (e) =>
      toast({ title: "Update failed", description: apiErrorDetail(e), variant: "destructive" }),
  });

  const autoSendMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PATCH", `/api/email-sequences/${sequenceId}/auto-send`, {
        enabled,
      });
      return res.json();
    },
    onSuccess: (_d, enabled) => {
      toast({
        title: enabled ? "Auto-send enabled" : "Auto-send disabled",
        description: enabled
          ? "Fully-rendered steps skip the approval queue. Drafts with missing fields still wait for review."
          : "Every step now waits for human approval.",
      });
      invalidateAll();
    },
    onError: (e) =>
      toast({
        title: "Could not change auto-send",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [segmentOpen, setSegmentOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<EnrollmentRow | null>(null);

  if (!sequenceId) return null;

  const sequence = detailQ.data?.sequence;
  const steps = detailQ.data?.steps ?? [];
  const analytics = detailQ.data?.analytics;
  const isOwnerOrCeo =
    !!user && !!sequence && (user.role === "ceo" || sequence.createdBy === user.id);

  const allEnrollments = enrollmentsQ.data?.enrollments ?? [];
  const enrollments =
    statusFilter === "all"
      ? allEnrollments
      : allEnrollments.filter((e) => e.status === statusFilter);

  const perStepByOrder = new Map<number, PerStepCounts>(
    (analytics?.perStep ?? []).map((p) => [p.stepOrder, p]),
  );

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <PageHeader
        title={sequence?.name ?? "Sequence"}
        backHref="/admin/email-sequences"
        backLabel="All sequences"
        subtitle={sequence?.description ?? undefined}
      />

      {detailQ.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !sequence ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Sequence not found.
            <div className="mt-3">
              <Button variant="outline" onClick={() => navigate("/admin/email-sequences")}>
                Back to sequences
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Controls row ── */}
          <div className="flex flex-wrap items-center gap-2">
            {sequence.status === "active" ? (
              <Badge data-testid="badge-sequence-status">Active</Badge>
            ) : sequence.status === "paused" ? (
              <Badge variant="secondary" data-testid="badge-sequence-status">
                Paused
              </Badge>
            ) : (
              <Badge variant="outline" data-testid="badge-sequence-status">
                Archived
              </Badge>
            )}
            {sequence.status === "paused" && (
              <Button
                size="sm"
                onClick={() => patchMutation.mutate({ status: "active" })}
                disabled={patchMutation.isPending || steps.length === 0}
                data-testid="button-activate-sequence"
              >
                <Play className="mr-1 h-4 w-4" /> Activate
              </Button>
            )}
            {sequence.status === "active" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => patchMutation.mutate({ status: "paused" })}
                disabled={patchMutation.isPending}
                data-testid="button-pause-sequence"
              >
                <Pause className="mr-1 h-4 w-4" /> Pause
              </Button>
            )}
            {sequence.status !== "archived" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveOpen(true)}
                disabled={patchMutation.isPending}
                data-testid="button-archive-sequence"
              >
                <Archive className="mr-1 h-4 w-4" /> Archive
              </Button>
            )}
            {sequence.status === "paused" && steps.length === 0 && (
              <span className="text-sm text-muted-foreground">Add steps before activating.</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="auto-send" className="text-sm">
                Auto-send
              </Label>
              <Switch
                id="auto-send"
                checked={sequence.autoSendEnabled}
                disabled={!isOwnerOrCeo || autoSendMutation.isPending}
                onCheckedChange={(v) => autoSendMutation.mutate(v)}
                data-testid="switch-auto-send"
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {sequence.autoSendEnabled
              ? "Auto-send is ON: fully-rendered steps send without approval. Steps with missing merge fields still queue for review."
              : "Approval required: every step waits as a draft in the approval queue."}
            {!isOwnerOrCeo && " Only the sequence owner or the CEO can change auto-send."}
          </p>

          {/* ── Analytics ── */}
          {analytics && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="Enrolled (all time)" value={analytics.enrolled} testId="stat-enrolled" />
              <StatCard label="In progress" value={analytics.inProgress} testId="stat-in-progress" />
              <StatCard label="Replied (cancelled)" value={analytics.replied} testId="stat-replied" />
              <StatCard label="Completed" value={analytics.completed} testId="stat-completed" />
              <StatCard label="Cancelled (other)" value={analytics.cancelledOther} testId="stat-cancelled-other" />
            </div>
          )}

          {/* ── Steps ── */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <div>
                <CardTitle>Steps</CardTitle>
                <CardDescription>
                  Emails send in order, separated by wait delays. Sends count approved steps.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStepsOpen(true)}
                disabled={sequence.status === "archived"}
                data-testid="button-edit-steps"
              >
                <Pencil className="mr-1 h-4 w-4" /> Edit steps
              </Button>
            </CardHeader>
            <CardContent>
              {steps.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground" data-testid="text-no-steps">
                  No steps yet — add the first email to make this sequence usable.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Step</TableHead>
                      <TableHead>Template</TableHead>
                      <TableHead>Timing</TableHead>
                      <TableHead className="text-right">Sent</TableHead>
                      <TableHead className="text-right">Awaiting approval</TableHead>
                      <TableHead className="text-right">Rejected</TableHead>
                      <TableHead className="text-right">Suppressed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {steps.map((s) => {
                      const counts = perStepByOrder.get(s.stepOrder);
                      return (
                        <TableRow key={s.id} data-testid={`row-step-${s.stepOrder}`}>
                          <TableCell>{s.stepOrder}</TableCell>
                          <TableCell className="font-medium">
                            <span className="inline-flex items-center gap-2">
                              {s.templateName}
                              {s.aiPersonalizationEnabled && (
                                <Badge variant="secondary" data-testid={`badge-step-ai-${s.stepOrder}`}>
                                  AI
                                </Badge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDelay(s.delayMinutes, s.stepOrder)}
                          </TableCell>
                          <TableCell className="text-right" data-testid={`text-step-${s.stepOrder}-sent`}>
                            {counts?.approved ?? 0}
                          </TableCell>
                          <TableCell className="text-right">{counts?.draft ?? 0}</TableCell>
                          <TableCell className="text-right">{counts?.rejected ?? 0}</TableCell>
                          <TableCell className="text-right">
                            {(counts?.suppressed ?? 0) + (counts?.renderFailed ?? 0)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ── Enrollments ── */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <div>
                <CardTitle>Enrollments</CardTitle>
                <CardDescription>
                  A contact can only be enrolled once at a time. Replies cancel the rest of their
                  steps automatically.
                </CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-36" data-testid="select-enrollment-filter">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSegmentOpen(true)}
                  disabled={sequence.status === "archived" || steps.length === 0}
                  data-testid="button-enroll-segment"
                >
                  <Users className="mr-1 h-4 w-4" /> Enroll segment
                </Button>
                <Button
                  size="sm"
                  onClick={() => setEnrollOpen(true)}
                  disabled={sequence.status === "archived" || steps.length === 0}
                  data-testid="button-enroll"
                >
                  <UserPlus className="mr-1 h-4 w-4" /> Enroll
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {enrollmentsQ.isLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : enrollments.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-enrollments">
                  {statusFilter === "all"
                    ? "Nobody is enrolled yet."
                    : `No ${statusFilter} enrollments.`}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Recipient</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Progress</TableHead>
                      <TableHead>Next step</TableHead>
                      <TableHead>Enrolled</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {enrollments.map((e) => (
                      <TableRow key={e.id} data-testid={`row-enrollment-${e.id}`}>
                        <TableCell className="font-medium">{e.recipientEmail}</TableCell>
                        <TableCell>
                          {e.status === "active" ? (
                            <Badge>Active</Badge>
                          ) : e.status === "completed" ? (
                            <Badge variant="secondary">Completed</Badge>
                          ) : (
                            <span title={e.cancelNote ?? undefined}>
                              <Badge
                                variant="destructive"
                                data-testid={`badge-cancel-reason-${e.id}`}
                              >
                                {CANCEL_REASON_LABELS[e.cancelReason ?? ""] ?? "Cancelled"}
                              </Badge>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {e.currentStepOrder}/{steps.length || "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {e.status === "active" ? fmtDateTime(e.nextStepAt) : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {fmtDateTime(e.createdAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          {e.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setCancelTarget(e)}
                              data-testid={`button-cancel-enrollment-${e.id}`}
                            >
                              <XCircle className="mr-1 h-4 w-4" /> Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* ── Dialogs ── */}
          <ArchiveDialog
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
            activeCount={analytics?.inProgress ?? 0}
            pending={patchMutation.isPending}
            onConfirm={() => {
              patchMutation.mutate({ status: "archived" });
              setArchiveOpen(false);
            }}
          />
          <EditStepsDialog
            open={stepsOpen}
            onOpenChange={setStepsOpen}
            sequenceId={sequenceId}
            existing={steps}
            templates={templatesQ.data?.templates ?? []}
            onSaved={invalidateAll}
          />
          <EnrollDialog
            open={enrollOpen}
            onOpenChange={setEnrollOpen}
            sequenceId={sequenceId}
            onEnrolled={() => {
              invalidateAll();
              void qc.invalidateQueries({
                queryKey: ["/api/email-sequences", sequenceId, "enrollments"],
              });
            }}
          />
          <EnrollSegmentDialog
            open={segmentOpen}
            onOpenChange={setSegmentOpen}
            sequenceId={sequenceId}
            onEnrolled={() => {
              invalidateAll();
              void qc.invalidateQueries({
                queryKey: ["/api/email-sequences", sequenceId, "enrollments"],
              });
            }}
          />
          <CancelEnrollmentDialog
            target={cancelTarget}
            onOpenChange={(o) => !o && setCancelTarget(null)}
            onCancelled={() => {
              setCancelTarget(null);
              invalidateAll();
              void qc.invalidateQueries({
                queryKey: ["/api/email-sequences", sequenceId, "enrollments"],
              });
            }}
          />
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, testId }: { label: string; value: number; testId: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-2xl font-semibold" data-testid={testId}>
          {value}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

// ── Archive confirm ──────────────────────────────────────────────────────────

function ArchiveDialog({
  open,
  onOpenChange,
  activeCount,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  activeCount: number;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this sequence?</DialogTitle>
          <DialogDescription>
            Archiving stops it permanently:{" "}
            {activeCount > 0
              ? `${activeCount} active enrollment(s) will be cancelled and their pending drafts discarded.`
              : "no enrollments are currently active."}{" "}
            History and analytics stay visible.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            data-testid="button-confirm-archive"
          >
            {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Archive sequence
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit steps ───────────────────────────────────────────────────────────────

function EditStepsDialog({
  open,
  onOpenChange,
  sequenceId,
  existing,
  templates,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sequenceId: string;
  existing: StepRow[];
  templates: Array<TemplateOption & { archived: boolean }>;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<StepDraft[] | null>(null);

  const initial: StepDraft[] = useMemo(
    () =>
      existing.map((s) => {
        const { delayValue, delayUnit } = fromDelayMinutes(s.delayMinutes);
        return {
          templateId: s.templateId,
          delayValue,
          delayUnit,
          aiPersonalize: s.aiPersonalizationEnabled,
        };
      }),
    [existing],
  );
  const steps = drafts ?? initial;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (steps.length === 0) throw new Error("A sequence needs at least one step");
      if (steps.some((s) => !s.templateId)) throw new Error("Every step needs a template");
      const res = await apiRequest("PUT", `/api/email-sequences/${sequenceId}/steps`, {
        steps: steps.map((s) => ({
          templateId: s.templateId,
          delayMinutes: toDelayMinutes(s),
          aiPersonalizationEnabled: s.aiPersonalize,
        })),
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Steps updated" });
      setDrafts(null);
      onOpenChange(false);
      onSaved();
    },
    onError: (e) =>
      toast({
        title: "Could not update steps",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setDrafts(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit steps</DialogTitle>
          <DialogDescription>
            Steps can only change while no enrollments are active — pause first, then wait for or
            cancel the stragglers.
          </DialogDescription>
        </DialogHeader>
        <SequenceStepsEditor steps={steps} templates={templates} onChange={setDrafts} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || steps.length === 0}
            data-testid="button-save-steps"
          >
            {saveMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Save steps
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Enroll one ───────────────────────────────────────────────────────────────

function EnrollDialog({
  open,
  onOpenChange,
  sequenceId,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sequenceId: string;
  onEnrolled: () => void;
}) {
  const { toast } = useToast();
  const [entityType, setEntityType] = useState<"client" | "contact">("client");
  const [clientId, setClientId] = useState("");
  const [contactId, setContactId] = useState("");
  const [sender, setSender] = useState(OWNER_SENTINEL);

  const clientsQ = useQuery<unknown>({ queryKey: ["/api/clients"], enabled: open });
  const clients = useMemo(() => normalizeClients(clientsQ.data), [clientsQ.data]);
  const clientDetailQ = useQuery<{ contacts?: ContactOption[] }>({
    queryKey: ["/api/clients", clientId],
    enabled: open && entityType === "contact" && !!clientId,
  });
  const contacts = clientDetailQ.data?.contacts ?? [];
  const usersQ = useQuery<AppUser[]>({ queryKey: ["/api/users"], enabled: open });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/email-sequences/${sequenceId}/enroll`, {
        entityType,
        entityId: entityType === "client" ? clientId : contactId,
        senderUserId: sender === OWNER_SENTINEL ? undefined : sender,
      });
      return res.json() as Promise<{ outcome: string; detail?: string }>;
    },
    onSuccess: () => {
      toast({ title: "Enrolled", description: "The first step is scheduled." });
      onOpenChange(false);
      setClientId("");
      setContactId("");
      setSender(OWNER_SENTINEL);
      onEnrolled();
    },
    onError: (e) =>
      toast({
        title: "Could not enroll",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const ready = entityType === "client" ? !!clientId : !!contactId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll in sequence</DialogTitle>
          <DialogDescription>
            One active enrollment per contact — re-enrolling someone already in the run is
            refused. Emails send from the assigned sender's own mailbox.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Record type</Label>
            <Select
              value={entityType}
              onValueChange={(v) => {
                setEntityType(v as "client" | "contact");
                setContactId("");
              }}
            >
              <SelectTrigger data-testid="select-enroll-entity-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client">Client (primary contact email)</SelectItem>
                <SelectItem value="contact">Specific contact</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Client</Label>
            <Select
              value={clientId || undefined}
              onValueChange={(v) => {
                setClientId(v);
                setContactId("");
              }}
            >
              <SelectTrigger data-testid="select-enroll-client">
                <SelectValue placeholder="Pick a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.firmName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {entityType === "contact" && (
            <div className="space-y-1">
              <Label className="text-xs">Contact</Label>
              <Select
                value={contactId || undefined}
                onValueChange={setContactId}
                disabled={!clientId}
              >
                <SelectTrigger data-testid="select-enroll-contact">
                  <SelectValue placeholder={clientId ? "Pick a contact" : "Pick a client first"} />
                </SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.emails?.[0] ? ` (${c.emails[0]})` : " (no email)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Sender</Label>
            <Select value={sender} onValueChange={setSender}>
              <SelectTrigger data-testid="select-enroll-sender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={OWNER_SENTINEL}>Client's assigned owner (default)</SelectItem>
                {(usersQ.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {userLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => enrollMutation.mutate()}
            disabled={!ready || enrollMutation.isPending}
            data-testid="button-confirm-enroll"
          >
            {enrollMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Enroll segment ───────────────────────────────────────────────────────────

function EnrollSegmentDialog({
  open,
  onOpenChange,
  sequenceId,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sequenceId: string;
  onEnrolled: () => void;
}) {
  const { toast } = useToast();
  const [segmentId, setSegmentId] = useState("");
  const [sender, setSender] = useState(OWNER_SENTINEL);

  const segmentsQ = useQuery<SegmentOption[]>({ queryKey: ["/api/segments"], enabled: open });
  const usersQ = useQuery<AppUser[]>({ queryKey: ["/api/users"], enabled: open });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/email-sequences/${sequenceId}/enroll-segment`, {
        segmentId,
        senderUserId: sender === OWNER_SENTINEL ? undefined : sender,
      });
      return res.json() as Promise<{
        summary: {
          total: number;
          enrolled: number;
          alreadyActive: number;
          skipped: Array<{ entityId: string; outcome: string }>;
        };
      }>;
    },
    onSuccess: (d) => {
      const s = d.summary;
      toast({
        title: `Enrolled ${s.enrolled} of ${s.total}`,
        description: `${s.alreadyActive} already active, ${s.skipped.length} skipped (no email, suppressed, or missing sender).`,
      });
      onOpenChange(false);
      setSegmentId("");
      setSender(OWNER_SENTINEL);
      onEnrolled();
    },
    onError: (e) =>
      toast({
        title: "Segment enrollment failed",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enroll a segment</DialogTitle>
          <DialogDescription>
            Every member gets its own enrollment; members already in the run, without an email, or
            on the suppression list are skipped and reported.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Segment</Label>
            <Select value={segmentId || undefined} onValueChange={setSegmentId}>
              <SelectTrigger data-testid="select-enroll-segment">
                <SelectValue placeholder="Pick a segment" />
              </SelectTrigger>
              <SelectContent>
                {(segmentsQ.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Sender</Label>
            <Select value={sender} onValueChange={setSender}>
              <SelectTrigger data-testid="select-segment-sender">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={OWNER_SENTINEL}>Each client's assigned owner (default)</SelectItem>
                {(usersQ.data ?? []).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {userLabel(u)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => enrollMutation.mutate()}
            disabled={!segmentId || enrollMutation.isPending}
            data-testid="button-confirm-enroll-segment"
          >
            {enrollMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Enroll segment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Cancel enrollment ────────────────────────────────────────────────────────

function CancelEnrollmentDialog({
  target,
  onOpenChange,
  onCancelled,
}: {
  target: EnrollmentRow | null;
  onOpenChange: (o: boolean) => void;
  onCancelled: () => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("No enrollment selected");
      const res = await apiRequest(
        "POST",
        `/api/email-sequences/enrollments/${target.id}/cancel`,
        note.trim() ? { note: note.trim() } : {},
      );
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Enrollment cancelled", description: "Remaining steps will not send." });
      setNote("");
      onCancelled();
    },
    onError: (e) =>
      toast({
        title: "Could not cancel",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this enrollment?</DialogTitle>
          <DialogDescription>
            {target?.recipientEmail} will receive no further steps from this sequence. Pending
            drafts are discarded.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="cancel-note" className="text-xs">
            Note (optional)
          </Label>
          <Input
            id="cancel-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. asked to follow up by phone instead"
            data-testid="input-cancel-note"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep enrolled
          </Button>
          <Button
            variant="destructive"
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
            data-testid="button-confirm-cancel-enrollment"
          >
            {cancelMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Cancel enrollment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
