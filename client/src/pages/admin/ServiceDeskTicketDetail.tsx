import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertCircle, ArrowLeft, ChevronRight, Clock, User, Building2, Calendar, RefreshCw, CheckCircle, RotateCcw, Link2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/admin/PageHeader";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Ticket {
  clickupTaskId: string;
  name: string;
  status: string | null;
  statusColor: string | null;
  url: string | null;
  priority: number | null;
  priorityName: string | null;
  dateCreated: string | null;
  dateUpdated: string | null;
  clientId: number | null;
  resolvedClientId: string | null;
  clientName: string | null;
  requesterUserId: string | null;
  requesterRaw: string | null;
  ownerUserId: string | null;
  departmentId: string | null;
  requestType: string | null;
  requestedDate: string | null;
  committedDate: string | null;
  waitingWho: string | null;
  waitingWhat: string | null;
  waitingWhen: string | null;
  assignees: Array<{ id: string | number; username: string }>;
  readAt: string | null;
  lastNotifiedAt: string | null;
  questionAnswers: Array<{ label: string; value: string }> | null;
}

interface TicketEvent {
  id: string;
  clickupTaskId: string;
  eventType: string;
  actorUserId: string | null;
  data: Record<string, any> | null;
  createdAt: string;
}

interface Department {
  id: string;
  name: string;
  active: boolean;
}

interface EligibleAssignee {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  clickupUserId: string | null;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  "submitted": "Submitted",
  "scheduled": "Scheduled",
  "in progress": "In Progress",
  "needs information": "Needs Information",
  "waiting on account manager": "Waiting on Account Manager",
  "waiting on client": "Waiting on Client",
  "waiting on approval": "Waiting on Approval",
  "blocked": "Blocked",
  "quality review": "Quality Review",
  "delivered": "Delivered",
  "closed": "Closed",
  "reopened": "Reopened",
  "out of scope": "Out of Scope",
  "canceled": "Canceled",
  "duplicate": "Duplicate",
};

const STATUS_COLORS: Record<string, string> = {
  "submitted": "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300",
  "scheduled": "bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300",
  "in progress": "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300",
  "needs information": "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-300",
  "waiting on account manager": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "waiting on client": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "waiting on approval": "bg-orange-100 text-orange-700 dark:bg-orange-950/30 dark:text-orange-300",
  "blocked": "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300",
  "quality review": "bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-300",
  "delivered": "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300",
  "closed": "bg-slate-200 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300",
  "reopened": "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300",
  "out of scope": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
  "canceled": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
  "duplicate": "bg-slate-100 text-slate-500 dark:bg-slate-800/40 dark:text-slate-400",
};

const WAITING_STATUSES = new Set([
  "waiting on account manager", "waiting on client", "waiting on approval", "blocked",
]);

const TERMINAL_STATUSES = new Set(["out of scope", "canceled", "duplicate"]);

function statusBadge(status: string | null) {
  if (!status) return null;
  const norm = status.toLowerCase().trim();
  const label = STATUS_LABELS[norm] ?? status;
  const colorClass = STATUS_COLORS[norm] ?? "bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-300";
  return (
    <span className={`inline-flex items-center rounded-pill px-2.5 py-0.5 text-xs font-medium ${colorClass}`}>
      {label}
    </span>
  );
}

// ─── Event log helpers ────────────────────────────────────────────────────────

function eventLabel(event: TicketEvent): string {
  const d = event.data ?? {};
  switch (event.eventType) {
    case "status_transition":
      return `Status: ${STATUS_LABELS[d.fromStatus] ?? d.fromStatus} → ${STATUS_LABELS[d.toStatus] ?? d.toStatus}`;
    case "reassignment":
      return `Reassigned to new owner`;
    case "department_change":
      return `Department changed`;
    case "committed_date_change": {
      const dt = d.newMs ? new Date(d.newMs).toLocaleDateString() : "—";
      return `Committed date set to ${dt}${d.isMovingLater ? " (extended)" : ""}`;
    }
    case "confirm_complete":
      return "Confirmed complete → Closed";
    case "reopen":
      return "Ticket reopened";
    case "mark_duplicate":
      return `Marked duplicate of ${d.linkedTaskId ?? "—"}`;
    case "waiting_on_set":
      return `Waiting on: ${d.waitingWho ?? "—"}`;
    case "cancel":
      return "Ticket canceled";
    default:
      return event.eventType.replace(/_/g, " ");
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ServiceDeskTicketDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Dialogs
  const [transitionDialog, setTransitionDialog] = useState<string | null>(null);
  const [reassignDialog, setReassignDialog] = useState(false);
  const [deptDialog, setDeptDialog] = useState(false);
  const [dateDialog, setDateDialog] = useState(false);
  const [reopenDialog, setReopenDialog] = useState(false);
  const [dupDialog, setDupDialog] = useState(false);

  // Form state
  const [waitingWho, setWaitingWho] = useState("");
  const [waitingWhat, setWaitingWhat] = useState("");
  const [waitingWhen, setWaitingWhen] = useState("");
  const [transitionReason, setTransitionReason] = useState("");
  const [linkedTaskId, setLinkedTaskId] = useState("");
  const [newOwnerUserId, setNewOwnerUserId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [newDeptId, setNewDeptId] = useState("");
  const [newDeptOwner, setNewDeptOwner] = useState("");
  const [deptReason, setDeptReason] = useState("");
  const [committedDate, setCommittedDate] = useState("");
  const [dateReason, setDateReason] = useState("");
  const [reopenExplanation, setReopenExplanation] = useState("");
  const [dupLinkedId, setDupLinkedId] = useState("");
  const [needsClickUpConnection, setNeedsClickUpConnection] = useState(false);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["sd-ticket", taskId] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({ queryKey: ["sd-ticket-events", taskId] }); // fire-and-forget: cache refresh only
    void qc.invalidateQueries({ queryKey: ["sd-allowed-transitions", taskId] }); // fire-and-forget: cache refresh only
  };

  // ─── Queries ───────────────────────────────────────────────────────────────

  const { data: ticketData, isLoading: ticketLoading, error: ticketError } = useQuery({
    queryKey: ["sd-ticket", taskId],
    queryFn: () => fetch(`/api/service-desk/tickets/${taskId}`).then((r) => r.json()),
    enabled: !!taskId,
    staleTime: 15_000,
  });

  const { data: eventsData } = useQuery({
    queryKey: ["sd-ticket-events", taskId],
    queryFn: () => fetch(`/api/service-desk/tickets/${taskId}/events`).then((r) => r.json()),
    enabled: !!taskId,
    staleTime: 10_000,
  });

  const { data: transitionsData } = useQuery({
    queryKey: ["sd-allowed-transitions", taskId],
    queryFn: () => fetch(`/api/service-desk/tickets/${taskId}/allowed-transitions`).then((r) => r.json()),
    enabled: !!taskId,
    staleTime: 10_000,
  });

  const { data: deptsData } = useQuery({
    queryKey: ["sd-departments"],
    queryFn: () => fetch("/api/service-desk/departments").then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: eligibleData } = useQuery({
    queryKey: ["sd-eligible-assignees"],
    queryFn: () => fetch("/api/service-desk/eligible-assignees").then((r) => r.json()),
    staleTime: 60_000,
  });

  const ticket: Ticket | null = ticketData?.ticket ?? null;
  const events: TicketEvent[] = eventsData?.events ?? [];
  const allowed: string[] = transitionsData?.allowed ?? [];
  const departments: Department[] = deptsData?.departments ?? [];
  const eligibleAssignees: EligibleAssignee[] = eligibleData?.assignees ?? [];

  const currentStatusNorm = (ticket?.status ?? "").toLowerCase().trim();
  const isTerminal = TERMINAL_STATUSES.has(currentStatusNorm);

  // ─── Mutations ─────────────────────────────────────────────────────────────

  const CLICKUP_CONNECT_MESSAGE = "Connect your ClickUp account to act on this ticket";

  function mutate(url: string, body: Record<string, any>, onOk?: () => void) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const json = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (
          json?.requiresClickUpConnection === true ||
          (r.status === 403 && typeof json?.error === "string" && /clickup not connected/i.test(json.error))
        ) {
          setNeedsClickUpConnection(true);
          throw new Error(CLICKUP_CONNECT_MESSAGE);
        }
        throw new Error(json.error ?? "Request failed");
      }
      setNeedsClickUpConnection(false);
      return json;
    }).then((json) => {
      invalidate();
      onOk?.();
      return json;
    });
  }

  const transitionMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/transition`, vars),
    onSuccess: () => {
      toast({ title: "Status updated" });
      setTransitionDialog(null);
      setWaitingWho(""); setWaitingWhat(""); setWaitingWhen(""); setTransitionReason(""); setLinkedTaskId("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const reassignMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/reassign`, vars),
    onSuccess: () => {
      toast({ title: "Ticket reassigned" });
      setReassignDialog(false);
      setNewOwnerUserId(""); setReassignReason("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const deptMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/change-department`, vars),
    onSuccess: () => {
      toast({ title: "Department updated" });
      setDeptDialog(false);
      setNewDeptId(""); setNewDeptOwner(""); setDeptReason("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const dateMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/committed-date`, vars),
    onSuccess: () => {
      toast({ title: "Committed date updated" });
      setDateDialog(false);
      setCommittedDate(""); setDateReason("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const confirmMutation = useMutation({
    mutationFn: () =>
      mutate(`/api/service-desk/tickets/${taskId}/confirm-complete`, {}),
    onSuccess: () => toast({ title: "Ticket closed — confirmed complete" }),
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const reopenMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/reopen`, vars),
    onSuccess: () => {
      toast({ title: "Ticket reopened" });
      setReopenDialog(false);
      setReopenExplanation("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const dupMutation = useMutation({
    mutationFn: (vars: Record<string, any>) =>
      mutate(`/api/service-desk/tickets/${taskId}/mark-duplicate`, vars),
    onSuccess: () => {
      toast({ title: "Marked as duplicate" });
      setDupDialog(false);
      setDupLinkedId("");
    },
    onError: (err: Error) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  // ─── Render helpers ────────────────────────────────────────────────────────

  function handleTransition(toStatus: string) {
    const norm = toStatus.toLowerCase().trim();
    if (norm === "duplicate") { setDupDialog(true); return; }
    setTransitionDialog(toStatus);
    setWaitingWho(""); setWaitingWhat(""); setWaitingWhen(""); setTransitionReason(""); setLinkedTaskId("");
  }

  function submitTransition() {
    if (!transitionDialog) return;
    transitionMutation.mutate({
      toStatus: transitionDialog,
      waitingWho: waitingWho || undefined,
      waitingWhat: waitingWhat || undefined,
      waitingWhen: waitingWhen || undefined,
      reason: transitionReason || undefined,
    });
  }

  // ─── Loading / error states ────────────────────────────────────────────────

  if (ticketLoading) {
    return (
      <div className="flex items-center justify-center h-64" data-testid="ticket-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading ticket…</span>
      </div>
    );
  }

  if (ticketError || !ticket) {
    return (
      <div className="p-6 max-w-2xl mx-auto" data-testid="ticket-error">
        <div className="flex items-center gap-2 text-destructive mb-4">
          <AlertCircle className="h-5 w-5" />
          <span>{ticketError ? String((ticketError as Error).message) : "Ticket not found"}</span>
        </div>
        <Button variant="outline" onClick={() => navigate("/admin/service-desk")} data-testid="btn-back-error">
          <ArrowLeft className="h-4 w-4 mr-1" /> Back to Service Desk
        </Button>
      </div>
    );
  }

  const committedMs = ticket.committedDate ? Number(ticket.committedDate) : null;
  const requestedMs = ticket.requestedDate ? Number(ticket.requestedDate) : null;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">

      {/* Header — shared admin PageHeader anatomy (Task #4450; audit §6.1-B).
          Existing testids preserved via backTestId/titleTestId; the status
          badge strip moves to its own row directly under the header. */}
      <PageHeader
        title={ticket.name}
        backHref="/admin/service-desk"
        backTestId="btn-back"
        titleTestId="ticket-name"
        subtitle="Internal service request"
        actions={
          ticket.url ? (
            <a href={ticket.url} target="_blank" rel="noopener noreferrer"
              className="shrink-0 text-xs text-primary-ink underline flex items-center gap-1"
              data-testid="link-clickup">
              Open in ClickUp <ChevronRight className="h-3 w-3" />
            </a>
          ) : undefined
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {statusBadge(ticket.status)}
        {ticket.priorityName && (
          <span className="text-xs text-muted-foreground">Priority: {ticket.priorityName}</span>
        )}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-clickup-task-id">
          ClickUp task
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            {ticket.clickupTaskId}
          </code>
        </span>
      </div>

      {needsClickUpConnection && (
        <div
          className="flex flex-wrap items-center gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="banner-clickup-connect"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Connect your ClickUp account to act on this ticket.</span>
          <a
            href="/admin/clickup"
            className="font-medium text-primary-ink underline"
            data-testid="link-connect-clickup"
          >
            Connect ClickUp
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

        {/* Details card */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Client</p>
                {ticket.clientId ? (
                  <a href={`/admin/clients/${ticket.clientId}`}
                    className="font-medium text-primary-ink hover:underline"
                    data-testid="link-client">
                    {ticket.clientName ?? "View Client"}
                  </a>
                ) : (
                  <p className="font-medium" data-testid="detail-client">{ticket.clientName ?? "—"}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Request Type</p>
                <p className="font-medium" data-testid="detail-request-type">{ticket.requestType ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Requester</p>
                <p className="font-medium" data-testid="detail-requester">{ticket.requesterRaw ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Assignees</p>
                <p className="font-medium" data-testid="detail-assignees">
                  {ticket.assignees.length > 0
                    ? ticket.assignees.map((a) => a.username).join(", ")
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Requested Date</p>
                <p className="font-medium" data-testid="detail-requested-date">
                  {requestedMs ? new Date(requestedMs).toLocaleDateString() : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  Committed Date
                  {!isTerminal && (
                    <button onClick={() => setDateDialog(true)} className="text-primary-ink hover:underline ml-1"
                      data-testid="btn-change-date">(change)</button>
                  )}
                </p>
                <p className="font-medium" data-testid="detail-committed-date">
                  {committedMs ? new Date(committedMs).toLocaleDateString() : "—"}
                </p>
              </div>
            </div>

            {/* Intake question answers (Task #3397) */}
            {ticket.questionAnswers && ticket.questionAnswers.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2" data-testid="section-question-answers">
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Intake Questions</p>
                  <div className="space-y-2 text-sm">
                    {ticket.questionAnswers.map((qa, i) => (
                      <div key={i} data-testid={`qa-item-${i}`}>
                        <p className="text-xs text-muted-foreground" data-testid={`qa-label-${i}`}>{qa.label}</p>
                        <p className="font-medium whitespace-pre-wrap break-words" data-testid={`qa-value-${i}`}>{qa.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Waiting-on info */}
            {WAITING_STATUSES.has(currentStatusNorm) && (
              <>
                <Separator />
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wide">Waiting on</p>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Who</p>
                      <p data-testid="detail-waiting-who">{ticket.waitingWho ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">What</p>
                      <p data-testid="detail-waiting-what">{ticket.waitingWhat ?? "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">By when</p>
                      <p data-testid="detail-waiting-when">{ticket.waitingWhen ?? "—"}</p>
                    </div>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Actions card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">

            {/* Confirm complete */}
            {currentStatusNorm === "delivered" && (
              <Button
                className="w-full" size="sm"
                onClick={() => confirmMutation.mutate()}
                disabled={confirmMutation.isPending}
                data-testid="btn-confirm-complete"
              >
                {confirmMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <CheckCircle className="h-4 w-4 mr-1" />}
                Confirm Complete
              </Button>
            )}

            {/* Reopen */}
            {(currentStatusNorm === "delivered" || currentStatusNorm === "closed") && (
              <Button
                variant="outline" className="w-full" size="sm"
                onClick={() => setReopenDialog(true)}
                data-testid="btn-reopen"
              >
                <RotateCcw className="h-4 w-4 mr-1" /> Reopen
              </Button>
            )}

            {/* Reassign */}
            {!isTerminal && (
              <Button variant="outline" className="w-full" size="sm"
                onClick={() => setReassignDialog(true)} data-testid="btn-reassign">
                <User className="h-4 w-4 mr-1" /> Reassign
              </Button>
            )}

            {/* Change department */}
            {!isTerminal && (
              <Button variant="outline" className="w-full" size="sm"
                onClick={() => setDeptDialog(true)} data-testid="btn-change-dept">
                <Building2 className="h-4 w-4 mr-1" /> Change Department
              </Button>
            )}

            {/* Mark duplicate */}
            {!isTerminal && (
              <Button variant="outline" className="w-full" size="sm"
                onClick={() => setDupDialog(true)} data-testid="btn-mark-duplicate">
                <Link2 className="h-4 w-4 mr-1" /> Mark Duplicate
              </Button>
            )}

            {/* Status transitions */}
            {allowed.length > 0 && (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground font-medium">Move to status</p>
                {allowed.map((s) => (
                  <Button key={s} variant="ghost" size="sm" className="w-full justify-start text-left"
                    onClick={() => handleTransition(s)} data-testid={`btn-transition-${s.replace(/\s+/g, "-")}`}>
                    <ChevronRight className="h-3 w-3 mr-1 shrink-0" />
                    {STATUS_LABELS[s.toLowerCase()] ?? s}
                  </Button>
                ))}
              </>
            )}

            {isTerminal && (
              <p className="text-xs text-muted-foreground text-center py-2">This ticket is closed (terminal status).</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Linked tickets (from mark-duplicate events) */}
      {(() => {
        const dupEvents = events.filter((e) => e.eventType === "mark_duplicate" && e.data?.linkedTaskId);
        if (dupEvents.length === 0) return null;
        return (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Link2 className="h-3.5 w-3.5" /> Linked Tickets
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm" data-testid="linked-tickets">
                {dupEvents.map((e) => (
                  <li key={e.id} className="flex items-center gap-2">
                    <span className="text-muted-foreground text-xs">Duplicate of:</span>
                    {ticket.url ? (
                      <a
                        href={ticket.url.replace(ticket.clickupTaskId, e.data!.linkedTaskId)}
                        target="_blank" rel="noopener noreferrer"
                        className="text-primary-ink hover:underline font-mono text-xs"
                        data-testid={`link-related-${e.data!.linkedTaskId}`}>
                        {e.data!.linkedTaskId}
                      </a>
                    ) : (
                      <span className="font-mono text-xs">{e.data!.linkedTaskId}</span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })()}

      {/* ClickUp comments & attachments */}
      {ticket.url && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Comments &amp; Attachments
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-2">
              Comments, file attachments, and watchers are managed in ClickUp.
            </p>
            <a href={ticket.url} target="_blank" rel="noopener noreferrer"
              className="text-sm text-primary-ink hover:underline flex items-center gap-1"
              data-testid="link-clickup-comments">
              <ChevronRight className="h-3.5 w-3.5" /> Open ticket in ClickUp
            </a>
          </CardContent>
        </Card>
      )}

      {/* Event log */}
      {events.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative border-l border-muted-foreground/20 space-y-3 ml-3">
              {events.map((ev) => (
                <li key={ev.id} className="ml-4 text-sm" data-testid={`event-${ev.id}`}>
                  <span className="absolute -left-1.5 mt-1 h-3 w-3 rounded-pill bg-muted-foreground/30 border border-background" />
                  <p className="font-medium">{eventLabel(ev)}</p>
                  {ev.data?.reason && (
                    <p className="text-xs text-muted-foreground mt-0.5">Reason: {ev.data.reason}</p>
                  )}
                  {ev.data?.explanation && (
                    <p className="text-xs text-muted-foreground mt-0.5">{ev.data.explanation}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {new Date(ev.createdAt).toLocaleString()}
                    {ev.actorUserId && ` · ${ev.actorUserId.slice(0, 8)}…`}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* ─── Dialogs ──────────────────────────────────────────────────────── */}

      {/* Status transition dialog */}
      <Dialog open={!!transitionDialog} onOpenChange={(open) => !open && setTransitionDialog(null)}>
        <DialogContent data-testid="dialog-transition">
          <DialogHeader>
            <DialogTitle>
              Move to: {transitionDialog ? (STATUS_LABELS[transitionDialog.toLowerCase()] ?? transitionDialog) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {transitionDialog && WAITING_STATUSES.has(transitionDialog.toLowerCase()) && (
              <>
                <div>
                  <Label htmlFor="waiting-who">Who are we waiting on? *</Label>
                  <Input id="waiting-who" data-testid="input-waiting-who"
                    value={waitingWho} onChange={(e) => setWaitingWho(e.target.value)}
                    placeholder="Name or team" />
                </div>
                <div>
                  <Label htmlFor="waiting-what">What do we need? *</Label>
                  <Input id="waiting-what" data-testid="input-waiting-what"
                    value={waitingWhat} onChange={(e) => setWaitingWhat(e.target.value)}
                    placeholder="Action or information needed" />
                </div>
                <div>
                  <Label htmlFor="waiting-when">Response needed by *</Label>
                  <Input id="waiting-when" data-testid="input-waiting-when"
                    value={waitingWhen} onChange={(e) => setWaitingWhen(e.target.value)}
                    placeholder="Date or deadline" />
                </div>
              </>
            )}
            <div>
              <Label htmlFor="transition-reason">Note (optional)</Label>
              <Textarea id="transition-reason" data-testid="input-transition-reason"
                value={transitionReason} onChange={(e) => setTransitionReason(e.target.value)}
                placeholder="Add a note about this status change…" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransitionDialog(null)}>Cancel</Button>
            <Button onClick={submitTransition} disabled={transitionMutation.isPending} data-testid="btn-confirm-transition">
              {transitionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reassign dialog */}
      <Dialog open={reassignDialog} onOpenChange={setReassignDialog}>
        <DialogContent data-testid="dialog-reassign">
          <DialogHeader><DialogTitle>Reassign Ticket</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-owner">New Owner *</Label>
              <Select value={newOwnerUserId} onValueChange={setNewOwnerUserId}>
                <SelectTrigger id="new-owner" data-testid="select-new-owner">
                  <SelectValue placeholder="Select a team member…" />
                </SelectTrigger>
                <SelectContent>
                  {eligibleAssignees.map((a) => (
                    <SelectItem key={a.userId} value={a.userId}>
                      {[a.firstName, a.lastName].filter(Boolean).join(" ") || a.email || a.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="reassign-reason">Reason (optional)</Label>
              <Textarea id="reassign-reason" data-testid="input-reassign-reason"
                value={reassignReason} onChange={(e) => setReassignReason(e.target.value)}
                placeholder="Why is this being reassigned?" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignDialog(false)}>Cancel</Button>
            <Button onClick={() => reassignMutation.mutate({ newOwnerUserId, reason: reassignReason || undefined })}
              disabled={!newOwnerUserId || reassignMutation.isPending} data-testid="btn-confirm-reassign">
              {reassignMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change department dialog */}
      <Dialog open={deptDialog} onOpenChange={setDeptDialog}>
        <DialogContent data-testid="dialog-change-dept">
          <DialogHeader><DialogTitle>Change Department</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="new-dept">Department *</Label>
              <Select value={newDeptId} onValueChange={setNewDeptId}>
                <SelectTrigger id="new-dept" data-testid="select-new-dept">
                  <SelectValue placeholder="Select department…" />
                </SelectTrigger>
                <SelectContent>
                  {departments.filter((d) => d.active).map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="dept-new-owner">New Owner (optional — reassigns simultaneously)</Label>
              <Select
                value={newDeptOwner || SELECT_NONE_VALUE}
                onValueChange={(v) => setNewDeptOwner(v === SELECT_NONE_VALUE ? "" : v)}
              >
                <SelectTrigger id="dept-new-owner" data-testid="select-dept-new-owner">
                  <SelectValue placeholder="Keep existing owner…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SELECT_NONE_VALUE}>Keep existing owner</SelectItem>
                  {eligibleAssignees.map((a) => (
                    <SelectItem key={a.userId} value={a.userId}>
                      {[a.firstName, a.lastName].filter(Boolean).join(" ") || a.email || a.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="dept-reason">Reason (optional)</Label>
              <Textarea id="dept-reason" data-testid="input-dept-reason"
                value={deptReason} onChange={(e) => setDeptReason(e.target.value)}
                placeholder="Why is the department changing?" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeptDialog(false)}>Cancel</Button>
            <Button
              onClick={() => deptMutation.mutate({
                newDepartmentId: newDeptId,
                newOwnerUserId: newDeptOwner || undefined,
                reason: deptReason || undefined,
              })}
              disabled={!newDeptId || deptMutation.isPending}
              data-testid="btn-confirm-change-dept">
              {deptMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Change Department
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Committed date dialog */}
      <Dialog open={dateDialog} onOpenChange={setDateDialog}>
        <DialogContent data-testid="dialog-committed-date">
          <DialogHeader><DialogTitle>Set Committed Date</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="committed-date">Date *</Label>
              <Input id="committed-date" type="date" data-testid="input-committed-date"
                value={committedDate} onChange={(e) => setCommittedDate(e.target.value)} />
              {committedMs && committedDate && new Date(committedDate).getTime() > committedMs && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Moving the date later requires a reason.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="date-reason">Reason {committedMs && committedDate && new Date(committedDate).getTime() > committedMs ? " *" : "(optional)"}</Label>
              <Textarea id="date-reason" data-testid="input-date-reason"
                value={dateReason} onChange={(e) => setDateReason(e.target.value)}
                placeholder="Why is the committed date changing?" rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDateDialog(false)}>Cancel</Button>
            <Button
              onClick={() => dateMutation.mutate({ committedDate, reason: dateReason || undefined })}
              disabled={!committedDate || dateMutation.isPending}
              data-testid="btn-confirm-date">
              {dateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Save Date
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reopen dialog */}
      <Dialog open={reopenDialog} onOpenChange={setReopenDialog}>
        <DialogContent data-testid="dialog-reopen">
          <DialogHeader><DialogTitle>Reopen Ticket</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Explain what was not completed or what remains to be done.
            </p>
            <div>
              <Label htmlFor="reopen-explanation">What remains incomplete? *</Label>
              <Textarea id="reopen-explanation" data-testid="input-reopen-explanation"
                value={reopenExplanation} onChange={(e) => setReopenExplanation(e.target.value)}
                placeholder="Describe what was not delivered or is still needed…" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenDialog(false)}>Cancel</Button>
            <Button
              onClick={() => reopenMutation.mutate({ explanation: reopenExplanation })}
              disabled={!reopenExplanation.trim() || reopenMutation.isPending}
              data-testid="btn-confirm-reopen">
              {reopenMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark duplicate dialog */}
      <Dialog open={dupDialog} onOpenChange={setDupDialog}>
        <DialogContent data-testid="dialog-duplicate">
          <DialogHeader><DialogTitle>Mark as Duplicate</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Link this ticket to the original ticket it duplicates. It will be closed automatically.
            </p>
            <div>
              <Label htmlFor="dup-linked-id">Original ticket ID *</Label>
              <Input id="dup-linked-id" data-testid="input-dup-linked-id"
                value={dupLinkedId} onChange={(e) => setDupLinkedId(e.target.value)}
                placeholder="ClickUp task ID (e.g. 86abc1234)" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupDialog(false)}>Cancel</Button>
            <Button
              onClick={() => dupMutation.mutate({ linkedTaskId: dupLinkedId })}
              disabled={!dupLinkedId.trim() || dupMutation.isPending}
              data-testid="btn-confirm-duplicate">
              {dupMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Mark as Duplicate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
