/**
 * Task #4335 — Email templates + approval-gated sequences (admin).
 *
 * Tabs:
 *   Sequences — named multi-step sequences (email steps + wait delays).
 *     Created paused; activation is deliberate. Row click opens the detail
 *     page (steps, enrollments, analytics, auto-send).
 *   Templates — the merge-field template library. Unknown tokens are a
 *     save-time 400; preview renders against a REAL client/contact record
 *     exactly like a sequence send would.
 *   Approvals — the human gate. Every step send lands here as a draft
 *     (unless the sequence owner enabled auto-send); approving hands the
 *     frozen rendered content to the outbound email service.
 *
 * The global kill switch (CEO-only) pauses every sequence step instantly —
 * step jobs defer, nothing sends, nothing is lost.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  CheckCircle2,
  Eye,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  SequenceStepsEditor,
  apiErrorDetail,
  fmtDateTime,
  toDelayMinutes,
  type StepDraft,
  type TemplateOption,
} from "@/components/admin/EmailSequenceShared";

// ── Types mirrored from the API ──────────────────────────────────────────────

interface SequenceListRow {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  autoSendEnabled: boolean;
  createdBy: string | null;
  createdAt: string;
  stepCount: number;
  activeEnrollments: number;
  pendingDrafts: number;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  archived: boolean;
  updatedAt: string;
}

interface ApprovalItem {
  id: string;
  enrollmentId: string;
  sequenceId: string;
  stepOrder: number;
  recipientEmail: string;
  senderUserId: string;
  renderedSubject: string;
  renderedBodyText: string;
  renderedBodyHtml: string | null;
  missingFields: string[] | null;
  aiPersonalized: boolean;
  status: "draft" | "render_failed";
  errorMessage: string | null;
  autoApproved: boolean;
  createdAt: string;
  sequenceName: string;
  clientId: string;
  entityType: string;
  entityId: string;
}

interface ClientOption {
  id: string;
  firmName: string;
  contactEmail?: string | null;
}

interface ContactOption {
  id: string;
  name: string;
  emails: string[] | null;
  isPrimary?: boolean | null;
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

function sequenceStatusBadge(status: SequenceListRow["status"]) {
  if (status === "active") return <Badge data-testid={`badge-status-${status}`}>Active</Badge>;
  if (status === "paused")
    return (
      <Badge variant="secondary" data-testid={`badge-status-${status}`}>
        Paused
      </Badge>
    );
  return (
    <Badge variant="outline" data-testid={`badge-status-${status}`}>
      Archived
    </Badge>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EmailSequencesAdmin() {
  const { user } = useAuth();
  const isCeo = user?.role === "ceo";
  const { toast } = useToast();
  const qc = useQueryClient();

  const settingsQ = useQuery<{ paused: boolean }>({
    queryKey: ["/api/email-sequences/settings"],
  });
  const paused = settingsQ.data?.paused === true;

  const templatesQ = useQuery<{ templates: TemplateRow[]; mergeFields: Record<string, string> }>({
    queryKey: ["/api/email-templates"],
  });
  const approvalsQ = useQuery<{ items: ApprovalItem[] }>({
    queryKey: ["/api/email-sequences/approvals"],
  });

  const killMutation = useMutation({
    mutationFn: async (nextPaused: boolean) => {
      const res = await apiRequest("POST", "/api/email-sequences/settings", {
        paused: nextPaused,
      });
      return res.json();
    },
    onSuccess: (_d, nextPaused) => {
      toast({
        title: nextPaused ? "All sequence sending paused" : "Sequence sending resumed",
        description: nextPaused
          ? "Step jobs defer until sending is resumed. Nothing is lost."
          : "Deferred steps resume on their next check (within ~30 minutes).",
      });
      void qc.invalidateQueries({ queryKey: ["/api/email-sequences/settings"] });
    },
    onError: (e) =>
      toast({
        title: "Could not update kill switch",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const pendingCount = approvalsQ.data?.items.length ?? 0;

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <PageHeader
        title="Email Sequences"
        backHref="/"
        icon={Send}
        subtitle="Templates, approval-gated sequences, and enrollment automation"
      />

      <Card className={paused ? "border-destructive" : undefined} data-testid="card-kill-switch">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            {paused ? (
              <ShieldAlert className="h-5 w-5 text-destructive" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            )}
            <div>
              <p className="font-medium" data-testid="text-kill-switch-state">
                {paused
                  ? "Global kill switch is ON — no sequence emails are sending"
                  : "Global kill switch"}
              </p>
              <p className="text-sm text-muted-foreground">
                {paused
                  ? "Step jobs defer until sending is resumed."
                  : "Pauses every sequence step send instantly. CEO only."}
              </p>
            </div>
          </div>
          <Switch
            checked={paused}
            disabled={!isCeo || killMutation.isPending || settingsQ.isLoading}
            onCheckedChange={(v) => killMutation.mutate(v)}
            aria-label="Pause all sequence sends"
            data-testid="switch-kill-switch"
          />
        </CardContent>
      </Card>

      <Tabs defaultValue="sequences">
        <TabsList>
          <TabsTrigger value="sequences" data-testid="tab-sequences">
            Sequences
          </TabsTrigger>
          <TabsTrigger value="templates" data-testid="tab-templates">
            Templates
          </TabsTrigger>
          <TabsTrigger value="approvals" data-testid="tab-approvals">
            Approvals
            {pendingCount > 0 && (
              <Badge variant="destructive" className="ml-2" data-testid="badge-pending-approvals">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sequences" className="mt-4">
          <SequencesTab templates={templatesQ.data?.templates ?? []} />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab
            templates={templatesQ.data?.templates ?? []}
            mergeFields={templatesQ.data?.mergeFields ?? {}}
            isLoading={templatesQ.isLoading}
          />
        </TabsContent>
        <TabsContent value="approvals" className="mt-4">
          <ApprovalsTab
            items={approvalsQ.data?.items ?? []}
            isLoading={approvalsQ.isLoading}
            isFetching={approvalsQ.isFetching}
            onRefresh={() => void approvalsQ.refetch()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Sequences tab ────────────────────────────────────────────────────────────

function SequencesTab({ templates }: { templates: TemplateRow[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<{ sequences: SequenceListRow[] }>({
    queryKey: ["/api/email-sequences"],
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([]);

  const templateOptions: TemplateOption[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    archived: t.archived,
  }));

  const createMutation = useMutation({
    mutationFn: async () => {
      if (steps.some((s) => !s.templateId)) {
        throw new Error("Every step needs a template");
      }
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || undefined,
      };
      if (steps.length > 0) {
        body.steps = steps.map((s) => ({
          templateId: s.templateId,
          delayMinutes: toDelayMinutes(s),
          aiPersonalizationEnabled: s.aiPersonalize,
        }));
      }
      const res = await apiRequest("POST", "/api/email-sequences", body);
      return res.json() as Promise<{ sequence: { id: string } }>;
    },
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ["/api/email-sequences"] });
      setCreateOpen(false);
      setName("");
      setDescription("");
      setSteps([]);
      navigate(`/admin/email-sequences/${d.sequence.id}`);
    },
    onError: (e) =>
      toast({
        title: "Could not create sequence",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const sequences = data?.sequences ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Sequences</CardTitle>
          <CardDescription>
            Ordered email steps with wait delays. New sequences start paused.
          </CardDescription>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-testid="button-new-sequence">
          <Plus className="mr-1 h-4 w-4" /> New sequence
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sequences.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-sequences">
            No sequences yet. Create one to start automating follow-ups.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right">Pending drafts</TableHead>
                <TableHead>Sending</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/admin/email-sequences/${s.id}`)}
                  data-testid={`row-sequence-${s.id}`}
                >
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{sequenceStatusBadge(s.status)}</TableCell>
                  <TableCell className="text-right">{s.stepCount}</TableCell>
                  <TableCell className="text-right">{s.activeEnrollments}</TableCell>
                  <TableCell className="text-right">
                    {s.pendingDrafts > 0 ? (
                      <Badge variant="destructive">{s.pendingDrafts}</Badge>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell>
                    {s.autoSendEnabled ? (
                      <Badge variant="secondary">Auto-send</Badge>
                    ) : (
                      <Badge variant="outline">Approval required</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDateTime(s.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New sequence</DialogTitle>
            <DialogDescription>
              Steps send from each enrollee's assigned sender. The sequence starts paused.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="seq-name">Name</Label>
              <Input
                id="seq-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Lead nurture — PI firms"
                data-testid="input-sequence-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seq-desc">Description (optional)</Label>
              <Textarea
                id="seq-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                data-testid="input-sequence-description"
              />
            </div>
            <div className="space-y-1">
              <Label>Steps</Label>
              <SequenceStepsEditor
                steps={steps}
                templates={templateOptions}
                onChange={setSteps}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!name.trim() || createMutation.isPending}
              data-testid="button-create-sequence"
            >
              {createMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Templates tab ────────────────────────────────────────────────────────────

const EMPTY_TEMPLATE = {
  name: "",
  description: "",
  subject: "",
  bodyText: "",
  bodyHtml: "",
};

function TemplatesTab({
  templates,
  mergeFields,
  isLoading,
}: {
  templates: TemplateRow[];
  mergeFields: Record<string, string>;
  isLoading: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_TEMPLATE });
  const [previewFor, setPreviewFor] = useState<TemplateRow | null>(null);

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_TEMPLATE });
    setEditorOpen(true);
  };
  const openEdit = (t: TemplateRow) => {
    setEditingId(t.id);
    setForm({
      name: t.name,
      description: t.description ?? "",
      subject: t.subject,
      bodyText: t.bodyText,
      bodyHtml: t.bodyHtml ?? "",
    });
    setEditorOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        subject: form.subject.trim(),
        bodyText: form.bodyText,
        bodyHtml: form.bodyHtml.trim() ? form.bodyHtml : null,
      };
      const res = editingId
        ? await apiRequest("PATCH", `/api/email-templates/${editingId}`, body)
        : await apiRequest("POST", "/api/email-templates", body);
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/email-templates"] });
      setEditorOpen(false);
      toast({ title: editingId ? "Template updated" : "Template created" });
    },
    onError: (e) =>
      toast({
        title: "Could not save template",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const archiveMutation = useMutation({
    mutationFn: async (t: TemplateRow) => {
      const res = await apiRequest("PATCH", `/api/email-templates/${t.id}`, {
        archived: !t.archived,
      });
      return res.json();
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/email-templates"] }),
    onError: (e) =>
      toast({
        title: "Could not update template",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Template library</CardTitle>
          <CardDescription>
            Merge fields like {"{{contact.firstName}}"} fill from the real record at send time.
          </CardDescription>
        </div>
        <Button onClick={openCreate} data-testid="button-new-template">
          <Plus className="mr-1 h-4 w-4" /> New template
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : templates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-templates">
            No templates yet. Sequences need at least one.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((t) => (
                <TableRow key={t.id} data-testid={`row-template-${t.id}`}>
                  <TableCell className="font-medium">
                    {t.name}
                    {t.archived && (
                      <Badge variant="outline" className="ml-2">
                        Archived
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-72 truncate text-sm">{t.subject}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fmtDateTime(t.updatedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPreviewFor(t)}
                        data-testid={`button-preview-template-${t.id}`}
                      >
                        <Eye className="mr-1 h-4 w-4" /> Preview
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(t)}
                        data-testid={`button-edit-template-${t.id}`}
                      >
                        <Pencil className="mr-1 h-4 w-4" /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => archiveMutation.mutate(t)}
                        data-testid={`button-archive-template-${t.id}`}
                      >
                        {t.archived ? "Restore" : "Archive"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>
              Unknown merge fields are rejected at save. Missing values at send time fall back to
              {" {{token|fallback}}"} text or flag the draft for review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  data-testid="input-template-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="tpl-desc">Description (optional)</Label>
                <Input
                  id="tpl-desc"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  data-testid="input-template-description"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                placeholder="Quick question for {{client.firmName}}"
                data-testid="input-template-subject"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-body">Body (plain text)</Label>
              <Textarea
                id="tpl-body"
                value={form.bodyText}
                onChange={(e) => setForm((f) => ({ ...f, bodyText: e.target.value }))}
                rows={10}
                placeholder={"Hi {{contact.firstName|there}},\n\n..."}
                data-testid="input-template-body"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-html">HTML body (optional)</Label>
              <Textarea
                id="tpl-html"
                value={form.bodyHtml}
                onChange={(e) => setForm((f) => ({ ...f, bodyHtml: e.target.value }))}
                rows={5}
                placeholder="Leave empty to send plain text only"
                data-testid="input-template-html"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Available merge fields</Label>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(mergeFields).map(([token, desc]) => (
                  <button
                    key={token}
                    type="button"
                    title={desc}
                    className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-primary hover:text-primary-foreground"
                    onClick={() =>
                      setForm((f) => ({ ...f, bodyText: `${f.bodyText}{{${token}}}` }))
                    }
                    data-testid={`chip-merge-${token.replace(".", "-")}`}
                  >
                    {"{{" + token + "}}"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={
                !form.name.trim() ||
                !form.subject.trim() ||
                !form.bodyText.trim() ||
                saveMutation.isPending
              }
              data-testid="button-save-template"
            >
              {saveMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {previewFor && (
        <TemplatePreviewDialog template={previewFor} onClose={() => setPreviewFor(null)} />
      )}
    </Card>
  );
}

interface PreviewResult {
  preview: {
    subject: string;
    bodyText: string;
    bodyHtml: string | null;
    missingFields: string[];
  };
  target: {
    clientId: string;
    clientName: string;
    recipientEmail: string | null;
    senderUserId: string;
  };
}

function TemplatePreviewDialog({
  template,
  onClose,
}: {
  template: TemplateRow;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [entityType, setEntityType] = useState<"client" | "contact">("client");
  const [clientId, setClientId] = useState("");
  const [contactId, setContactId] = useState("");
  const [result, setResult] = useState<PreviewResult | null>(null);

  const clientsQ = useQuery<unknown>({ queryKey: ["/api/clients"] });
  const clients = useMemo(() => normalizeClients(clientsQ.data), [clientsQ.data]);

  const clientDetailQ = useQuery<{ contacts?: ContactOption[] }>({
    queryKey: ["/api/clients", clientId],
    enabled: entityType === "contact" && !!clientId,
  });
  const contacts = clientDetailQ.data?.contacts ?? [];

  const previewMutation = useMutation({
    mutationFn: async () => {
      const entityId = entityType === "client" ? clientId : contactId;
      const res = await apiRequest("POST", `/api/email-templates/${template.id}/preview`, {
        entityType,
        entityId,
      });
      return res.json() as Promise<PreviewResult>;
    },
    onSuccess: (d) => setResult(d),
    onError: (e) =>
      toast({
        title: "Preview failed",
        description: apiErrorDetail(e),
        variant: "destructive",
      }),
  });

  const canRender = entityType === "client" ? !!clientId : !!contactId;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Preview — {template.name}</DialogTitle>
          <DialogDescription>
            Renders against a real record, exactly like a sequence send would.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-32 space-y-1">
            <Label className="text-xs">Record type</Label>
            <Select
              value={entityType}
              onValueChange={(v) => {
                setEntityType(v as "client" | "contact");
                setContactId("");
                setResult(null);
              }}
            >
              <SelectTrigger aria-label="Record type" data-testid="select-preview-entity-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="client">Client</SelectItem>
                <SelectItem value="contact">Contact</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-56 flex-1 space-y-1">
            <Label className="text-xs">Client</Label>
            <Select
              value={clientId || undefined}
              onValueChange={(v) => {
                setClientId(v);
                setContactId("");
                setResult(null);
              }}
            >
              <SelectTrigger aria-label="Client" data-testid="select-preview-client">
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
            <div className="min-w-56 flex-1 space-y-1">
              <Label className="text-xs">Contact</Label>
              <Select
                value={contactId || undefined}
                onValueChange={(v) => {
                  setContactId(v);
                  setResult(null);
                }}
                disabled={!clientId}
              >
                <SelectTrigger aria-label="Contact" data-testid="select-preview-contact">
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
          <Button
            onClick={() => previewMutation.mutate()}
            disabled={!canRender || previewMutation.isPending}
            data-testid="button-render-preview"
          >
            {previewMutation.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-1 h-4 w-4" />
            )}
            Render
          </Button>
        </div>

        {result && (
          <div className="space-y-3 rounded-md border p-4" data-testid="panel-preview-result">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                To: <span className="text-foreground">{result.target.recipientEmail ?? "(no email on record)"}</span>
              </span>
              <span>
                Client: <span className="text-foreground">{result.target.clientName}</span>
              </span>
            </div>
            {result.preview.missingFields.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-sm">
                <Badge variant="destructive">Missing</Badge>
                {result.preview.missingFields.map((f) => (
                  <code key={f} className="rounded bg-muted px-1 text-xs">
                    {f}
                  </code>
                ))}
              </div>
            )}
            <div>
              <p className="text-xs font-medium text-muted-foreground">Subject</p>
              <p className="font-medium" data-testid="text-preview-subject">
                {result.preview.subject}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Body</p>
              <pre className="whitespace-pre-wrap font-sans text-sm" data-testid="text-preview-body">
                {result.preview.bodyText}
              </pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Approvals tab ────────────────────────────────────────────────────────────

function ApprovalsTab({
  items,
  isLoading,
  isFetching,
  onRefresh,
}: {
  items: ApprovalItem[];
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewing, setReviewing] = useState<ApprovalItem | null>(null);
  // Task #4478 — drafts are editable before approval.
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");

  const openReview = (item: ApprovalItem) => {
    setReviewing(item);
    setEditing(false);
    setEditSubject(item.renderedSubject);
    setEditBody(item.renderedBodyText);
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["/api/email-sequences/approvals"] });
    void qc.invalidateQueries({ queryKey: ["/api/email-sequences"] });
  };

  const approveMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/email-sequences/step-sends/${id}/approve`);
      return res.json() as Promise<{ outcome: string; detail?: string }>;
    },
    onSuccess: (d) => {
      if (d.outcome === "sent") {
        toast({ title: "Approved", description: "Handed to the outbound email service." });
      } else if (d.outcome === "suppressed") {
        toast({
          title: "Recipient suppressed",
          description: "The address is on the suppression list — enrollment cancelled.",
          variant: "destructive",
        });
      }
      setReviewing(null);
      invalidate();
    },
    onError: (e) => {
      toast({
        title: "Could not approve",
        description: apiErrorDetail(e),
        variant: "destructive",
      });
      invalidate();
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/email-sequences/step-sends/${id}/reject`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rejected", description: "Step skipped — the sequence continues." });
      setReviewing(null);
      invalidate();
    },
    onError: (e) => {
      toast({
        title: "Could not reject",
        description: apiErrorDetail(e),
        variant: "destructive",
      });
      invalidate();
    },
  });

  const editMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest(
        "PATCH",
        `/api/email-sequences/step-sends/${reviewing!.id}`,
        { subject: editSubject, bodyText: editBody },
      );
      return res.json() as Promise<{
        outcome: string;
        stepSend?: { renderedSubject: string; renderedBodyText: string };
      }>;
    },
    onSuccess: (d) => {
      if (d.outcome === "edited" && d.stepSend && reviewing) {
        setReviewing({
          ...reviewing,
          renderedSubject: d.stepSend.renderedSubject,
          renderedBodyText: d.stepSend.renderedBodyText,
          missingFields: [],
          errorMessage: null,
        });
      }
      setEditing(false);
      toast({ title: "Draft updated", description: "Approving now sends the edited content." });
      invalidate();
    },
    onError: (e) => {
      toast({
        title: "Could not save edits",
        description: apiErrorDetail(e),
        variant: "destructive",
      });
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div>
          <CardTitle>Approval queue</CardTitle>
          <CardDescription>
            Drafts wait here for a human. Approving sends exactly the frozen content below.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} data-testid="button-refresh-approvals">
          <RefreshCw className={`mr-1 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-approvals">
            Queue is clear — nothing waiting for approval.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Sequence</TableHead>
                <TableHead className="text-right">Step</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} data-testid={`row-approval-${item.id}`}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {fmtDateTime(item.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium">{item.sequenceName}</TableCell>
                  <TableCell className="text-right">{item.stepOrder}</TableCell>
                  <TableCell className="text-sm">{item.recipientEmail}</TableCell>
                  <TableCell className="max-w-64 truncate text-sm">
                    {item.status === "render_failed" ? (
                      <span className="text-destructive">Render failed</span>
                    ) : (
                      item.renderedSubject
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {item.status === "render_failed" ? (
                        <Badge variant="destructive">Render failed</Badge>
                      ) : (item.missingFields?.length ?? 0) > 0 ? (
                        <Badge variant="destructive">
                          {item.missingFields!.length} missing
                        </Badge>
                      ) : item.status === "draft" && item.errorMessage ? (
                        <Badge variant="destructive">AI failed</Badge>
                      ) : (
                        <Badge variant="secondary">Ready</Badge>
                      )}
                      {item.aiPersonalized && (
                        <Badge variant="outline" data-testid={`badge-ai-${item.id}`}>
                          AI
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openReview(item)}
                      data-testid={`button-review-${item.id}`}
                    >
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <Dialog open={!!reviewing} onOpenChange={(o) => !o && setReviewing(null)}>
        {reviewing && (
          <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {reviewing.sequenceName} — step {reviewing.stepOrder}
              </DialogTitle>
              <DialogDescription>
                To {reviewing.recipientEmail}. What you approve is exactly what sends.
                {reviewing.aiPersonalized && " This draft was AI-personalized — review closely."}
              </DialogDescription>
            </DialogHeader>
            {reviewing.status === "render_failed" ? (
              <div className="rounded-md border border-destructive/50 p-3 text-sm">
                <p className="font-medium text-destructive">Render failed</p>
                <p className="mt-1 text-muted-foreground">
                  {reviewing.errorMessage ?? "Template could not be rendered for this record."}
                </p>
                <p className="mt-1 text-muted-foreground">
                  Reject to skip this step; the sequence continues with the next one.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {(reviewing.missingFields?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <Badge variant="destructive">Missing fields</Badge>
                    {reviewing.missingFields!.map((f) => (
                      <code key={f} className="rounded bg-muted px-1 text-xs">
                        {f}
                      </code>
                    ))}
                  </div>
                )}
                {reviewing.errorMessage && (
                  <div
                    className="rounded border border-destructive/50 p-3 text-sm text-muted-foreground"
                    data-testid="text-review-error"
                  >
                    <p className="font-medium text-destructive">Needs attention</p>
                    <p className="mt-1">{reviewing.errorMessage}</p>
                  </div>
                )}
                {editing ? (
                  <>
                    <div>
                      <Label htmlFor="edit-draft-subject" className="text-xs font-medium text-muted-foreground">
                        Subject
                      </Label>
                      <Input
                        id="edit-draft-subject"
                        value={editSubject}
                        onChange={(e) => setEditSubject(e.target.value)}
                        data-testid="input-edit-subject"
                      />
                    </div>
                    <div>
                      <Label htmlFor="edit-draft-body" className="text-xs font-medium text-muted-foreground">
                        Body (plain text — edited drafts send text only)
                      </Label>
                      <Textarea
                        id="edit-draft-body"
                        value={editBody}
                        onChange={(e) => setEditBody(e.target.value)}
                        rows={12}
                        data-testid="textarea-edit-body"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Subject</p>
                      <p className="font-medium" data-testid="text-review-subject">
                        {reviewing.renderedSubject}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Body</p>
                      <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded border p-3 font-sans text-sm" data-testid="text-review-body">
                        {reviewing.renderedBodyText}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => rejectMutation.mutate(reviewing.id)}
                disabled={rejectMutation.isPending || approveMutation.isPending || editMutation.isPending}
                data-testid="button-reject-step-send"
              >
                {rejectMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="mr-1 h-4 w-4" />
                )}
                Reject (skip step)
              </Button>
              {reviewing.status === "draft" && !editing && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditSubject(reviewing.renderedSubject);
                    setEditBody(reviewing.renderedBodyText);
                    setEditing(true);
                  }}
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                  data-testid="button-edit-step-send"
                >
                  <Pencil className="mr-1 h-4 w-4" />
                  Edit draft
                </Button>
              )}
              {reviewing.status === "draft" && editing && (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => setEditing(false)}
                    disabled={editMutation.isPending}
                    data-testid="button-cancel-edit"
                  >
                    Cancel edit
                  </Button>
                  <Button
                    onClick={() => editMutation.mutate()}
                    disabled={
                      editMutation.isPending ||
                      editSubject.trim().length === 0 ||
                      editBody.trim().length === 0
                    }
                    data-testid="button-save-edit"
                  >
                    {editMutation.isPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1 h-4 w-4" />
                    )}
                    Save edits
                  </Button>
                </>
              )}
              {reviewing.status === "draft" && !editing && (
                <Button
                  onClick={() => approveMutation.mutate(reviewing.id)}
                  disabled={approveMutation.isPending || rejectMutation.isPending}
                  data-testid="button-approve-step-send"
                >
                  {approveMutation.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                  )}
                  Approve & send
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
