import { useAuth } from "@/hooks/use-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { ClientFilesTab } from "@/components/clientFiles/ClientFilesTab";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Link, useParams, useLocation, useSearch } from "wouter";
import { ClientDealsCard } from "@/components/ClientDealsCard";
import ClientSchedulingPanel from "@/components/booking/ClientSchedulingPanel";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { PRACTICE_AREA_OPTIONS } from "@shared/practiceAreas";
import {
  type ClientTerminology,
  type UniversalAssignmentRoleState,
  type UniversalAssignmentSnapshot,
} from "@shared/schema";
import IntelligenceFeed from "@/components/IntelligenceFeed";
import ActionLog from "@/components/ActionLog";
import CommandPanel from "@/components/CommandPanel";
import RawCommunicationLog from "@/components/RawCommunicationLog";
import LocalDominanceDashboard from "@/components/LocalDominanceDashboard";
import AgentProfile from "@/components/AgentProfile";
import MatchDecisionAudit from "@/components/MatchDecisionAudit";
import ClientAgentChat from "@/components/ClientAgentChat";
import DailyJudgmentStream from "@/components/DailyJudgmentStream";
import AgentKnowledgePanel from "@/components/AgentKnowledgePanel";
import BillingSection from "@/components/BillingSection";
import LiveDataTab from "@/components/LiveDataTab";
import ClientCommsChatterFeed from "@/components/ClientCommsChatterFeed";
import { ClientDetailSkeleton, InlineLoadingSkeleton } from "@/components/ui/skeleton-loaders";
import { AuditHistoryPopover, useAuditHistory } from "@/components/AuditHistoryPopover";
import { ClientCommsQuickActions, PhoneHubIconActions } from "@/components/ClientCommsQuickActions";
import { useDeferredEnabled } from "@/hooks/use-deferred-enabled";
import { apiRequest, CLIENT_HEAVY_QUERY_STALE_TIME_MS, primaryQuerySemaphore, deferredQuerySemaphore, throttledFetch } from "@/lib/queryClient";
import { SmsConsentBadge, useSmsConsentStatusBatch } from "@/components/SmsConsentBadge";
import { RecordTagsCard } from "@/components/tags/RecordTagsCard";
import { ClientTimeline } from "@/components/ClientTimeline";
import { ArrowLeft, FileText, Plus, Pencil, Archive, ArchiveRestore, Trash2, Database, Copy, Star, Lightbulb, ClipboardList, Shield, MessageSquare, Radar, Brain, Bot, Scale, Mail, Phone, User, ExternalLink, CreditCard, Calendar, Video, Eye, Check, X, Sparkles, BarChart3, TicketCheck, CalendarClock, FlaskConical, FolderOpen, History, Briefcase } from "lucide-react";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { DangerZone } from "@/components/kit/DangerZone";
import { ConfirmActionDialog } from "@/components/kit/ConfirmActionDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { projectionToastLabel } from "@/components/ui/ClickUpProjectionStatus";

type Client = {
  id: string;
  clientCode: string | null;
  firmName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  consultType: string | null;
  practiceAreas: string[] | null;
  products: string[] | null;
  ownerId: string | null;
  averageCaseValue: number | null;
  monthlyReviewTarget: number | null;
  initialLeads: number | null;
  initialReviews: number | null;
  initialCases: number | null;
  stripeCustomerId: string | null;
  isArchived: boolean | null;
  // Demo/placeholder account — excluded from churn + dashboard aggregations.
  isDemo: boolean | null;
  clientStartDate: string | null;
  hasPostConsultReviewAccess: boolean | null;
  hasPostCaseClosedReviewAccess: boolean | null;
  // Task #2667 — per-client toggle: hide the "Other" lead bucket on reports.
  hideOtherLeads: boolean | null;
  terminology: ClientTerminology | null;
  // Task #867 — per-client trusted domains for the Front hard-match rule.
  emailDomains: string[] | null;
};

type Report = {
  id: string;
  clientId: string;
  reportMonth: string;
  status: string;
  shareToken: string | null;
  // Task #4537 — operator "Presented / Delivered" mark (ISO timestamp when
  // set). Raw report rows flow through /api/clients/:id/summary unchanged.
  presentedAt?: string | null;
};

type RerRecording = {
  id: string;
  commandPanelId: string;
  clientId: string;
  rawCommunicationRecordId: string;
  reportingMonth: string;
  assignedBy: string | null;
  assignedAt: string | null;
  communication: {
    id: string;
    title: string;
    timestamp: string;
    sourceType: string;
    contentText: string | null;
    aiSummary: string | null;
    contentPreview: string | null;
  } | null;
};

type CommRecord = {
  id: string;
  title: string;
  timestamp: string;
  sourceType: string;
};

type ContactSummary = {
  id: string;
  name: string;
  emails: string[] | null;
  phones: string[] | null;
  roleTitle: string | null;
  isPrimary: boolean;
};

// Task #3711 — scheduled offboarding attached to the client summary payload.
type ClientOffboardingSummary = {
  id: string;
  finalServiceDate: string; // YYYY-MM-DD (America/New_York calendar date)
  status: string;
};

// Format a YYYY-MM-DD calendar date without a timezone shift (new Date("YYYY-MM-DD")
// parses as UTC midnight and can render the previous day in western zones).
function formatFinalServiceDay(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return format(new Date(y, m - 1, d), "MMM d, yyyy");
}

function MatchingContactsSummary({ contacts = [], isLoading, onNavigate, clientId }: { contacts?: ContactSummary[]; isLoading?: boolean; onNavigate: () => void; clientId?: string }) {
  // Task #4336 — surface SMS consent state next to every contact phone.
  const allPhones = React.useMemo(
    () => contacts.flatMap((c) => (c.phones ?? []).filter((p): p is string => Boolean(p))),
    [contacts],
  );
  const { data: consentStatuses } = useSmsConsentStatusBatch(allPhones);
  return (
    <Card className="bg-card border-primary/10" data-testid="matching-contacts-summary">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-foreground flex items-center gap-2 text-base">
            <User className="w-4 h-4" />
            Contacts
          </CardTitle>
          <Button variant="ghost" size="sm" className="text-xs text-primary-ink/60 hover:text-primary-ink" onClick={onNavigate} data-testid="button-manage-contacts">
            <ExternalLink className="w-3 h-3 mr-1" />
            Manage in Command Panel
          </Button>
        </div>
        <CardDescription className="text-xs">
          Contact info used by the matching agent to identify communications
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <InlineLoadingSkeleton lines={2} />
        ) : contacts.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-sm text-muted-foreground mb-2">No contacts configured yet.</p>
            <Button variant="outline" size="sm" onClick={onNavigate} data-testid="button-add-contacts-command">
              Add contacts in Command Panel
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {contacts.map((c) => (
              <div key={c.id} className="flex items-start gap-3 p-2 rounded-lg bg-surface-warm-1/50 border border-primary/5">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-primary">{c.name}</span>
                    <span className="font-medium text-sm text-foreground">{c.name}</span>
                    {c.roleTitle && <span className="text-xs text-muted-foreground">{c.roleTitle}</span>}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                    {c.emails?.filter(Boolean).map((email, i) => (
                      <span key={i} className="text-xs text-muted-foreground flex items-center gap-1">
                        <Mail className="w-3 h-3" />{email}
                      </span>
                    ))}
                    {c.phones?.filter(Boolean).map((phone, i) => (
                      <span key={i} className="text-xs text-muted-foreground flex items-center gap-1">
                        <Phone className="w-3 h-3" />{phone}
                        <SmsConsentBadge status={consentStatuses?.[phone]} compact />
                        {clientId && (
                          <PhoneHubIconActions
                            phone={phone}
                            contactName={c.name}
                            clientId={clientId}
                            messageTestId={`button-contact-message-${c.id}-${i}`}
                            callTestId={`button-contact-call-${c.id}-${i}`}
                          />
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


type User = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
};

const TAB_MAP: Record<string, string> = {
  "command-panel": "command-panel",
  "intelligence": "intelligence",
  "intelligence-feed": "intelligence",
  "action-log": "action-log",
  "overview": "command-panel",
  "comm-log": "comm-log",
  "messaging": "comm-log",
  "timeline": "timeline",
  "local-dominance": "local-dominance",
  "matching-agent": "matching-agent",
  "agent-chat": "agent-chat",
  "daily-judgment": "daily-judgment",
  "billing": "billing",
  "reports": "reports",
  "files": "files",
  "team-chat": "team-chat",
  "sd-team": "sd-team",
  // Task #4349 — these three tabs existed but were missing from TAB_MAP, so
  // sharing/reloading their URLs silently fell back to command-panel.
  "agent-memory": "agent-memory",
  "scheduling": "scheduling",
  "live-data": "live-data",
};

// Task #4349 — evidence-derived grouping of the 16 leaf tabs into 6 domains.
// Per-tab intent study + rationale: audits/client-panel-tab-inventory-2026-08.md.
// The URL contract is untouched: ?tab= still carries the LEAF id; domains are
// presentation only (derived via DOMAIN_BY_TAB). Every leaf keeps its id,
// data-testid (tab-<id>), icon, and content.
type TabLeaf = { id: string; label: string; icon: React.ComponentType<{ className?: string }> };
type TabDomain = { id: string; label: string; icon: React.ComponentType<{ className?: string }>; tabs: TabLeaf[] };

const TAB_DOMAINS: TabDomain[] = [
  {
    id: "overview",
    label: "Overview",
    icon: Shield,
    tabs: [{ id: "command-panel", label: "Command", icon: Shield }],
  },
  {
    id: "comms",
    label: "Comms",
    icon: MessageSquare,
    tabs: [
      { id: "comm-log", label: "Comm Log", icon: MessageSquare },
      { id: "timeline", label: "Timeline", icon: History },
      { id: "daily-judgment", label: "Judgment", icon: Scale },
      { id: "team-chat", label: "Team Chat", icon: MessageSquare },
    ],
  },
  {
    id: "journal",
    label: "Journal",
    icon: ClipboardList,
    tabs: [
      { id: "intelligence", label: "Intel", icon: Lightbulb },
      { id: "action-log", label: "Actions", icon: ClipboardList },
    ],
  },
  {
    id: "agent",
    label: "Agent",
    icon: Bot,
    tabs: [
      { id: "agent-chat", label: "Chat", icon: Bot },
      { id: "agent-memory", label: "Memory", icon: Database },
      { id: "matching-agent", label: "Matching", icon: Brain },
    ],
  },
  {
    id: "performance",
    label: "Performance",
    icon: BarChart3,
    tabs: [
      { id: "local-dominance", label: "Local", icon: Radar },
      { id: "live-data", label: "Live Data", icon: BarChart3 },
      { id: "reports", label: "Reports", icon: FileText },
    ],
  },
  {
    id: "ops",
    label: "Ops",
    icon: Briefcase,
    tabs: [
      { id: "scheduling", label: "Schedule", icon: Calendar },
      { id: "files", label: "Files", icon: FolderOpen },
      { id: "billing", label: "Billing", icon: CreditCard },
      { id: "sd-team", label: "SD Team", icon: TicketCheck },
    ],
  },
];

const DOMAIN_BY_TAB: Record<string, string> = Object.fromEntries(
  TAB_DOMAINS.flatMap((d) => d.tabs.map((t) => [t.id, d.id])),
);

// ─── Client SD Team Assignment Panel ──────────────────────────────────────────
// Shows per-department primary + backup service desk assignees for this client.
// Team leads and above can update assignments.

interface SdDeptAssignment {
  id: string;
  clientId: string;
  departmentId: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
}

interface SdDeptRow {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  assignmentScope?: "per_client" | "company";
  defaultPrimaryUserId?: string | null;
  defaultCheckerUserId?: string | null;
  roleCapabilities?: {
    checker: boolean;
  };
}

type ClientRoleDisplayKey = "primary" | "checker";

function ClientRoleValue({
  role,
  label,
  departmentId,
  state,
  userName,
}: {
  role: ClientRoleDisplayKey;
  label: string;
  departmentId: string;
  state: UniversalAssignmentRoleState | undefined;
  userName: (userId: string | null | undefined) => string;
}) {
  const roleNameTestId = `text-${role}-name-${departmentId}`;
  const inheritedTestId =
    role === "primary"
      ? `badge-dept-default-${departmentId}`
      : `badge-dept-default-${role}-${departmentId}`;
  const sourceLabel =
    state?.source === "client_override"
      ? "Explicit"
      : state?.source === "default"
        ? "Inherited default"
        : state?.source === "company"
          ? "Company-wide"
          : null;
  const sourceTestId =
    state?.source === "client_override" && role === "primary"
      ? `badge-client-override-${departmentId}`
      : state?.source === "default"
        ? inheritedTestId
        : undefined;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="font-medium">{label}:</span>{" "}
      {state?.userId ? (
        <>
          <span data-testid={roleNameTestId}>{userName(state.userId)}</span>
          {sourceLabel && (
            <Badge
              variant="outline"
              className="text-caption px-1.5 py-0"
              data-testid={sourceTestId}
            >
              {sourceLabel}
            </Badge>
          )}
          {state.stale && (
            <Badge
              variant="secondary"
              className="text-caption px-1.5 py-0 bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800"
              title="This person is no longer an active member of the department and does not count as coverage."
              data-testid={`badge-stale-${role}-${departmentId}`}
            >
              Stale membership
            </Badge>
          )}
        </>
      ) : (
        <span data-testid={roleNameTestId}>None</span>
      )}
    </div>
  );
}

function ClientSdTeamPanel({
  clientId,
  allUsers,
}: {
  clientId: string;
  allUsers: User[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const assignmentsQuery = useQuery<{
    assignments: SdDeptAssignment[];
    departments: SdDeptRow[];
    membersByDept: Record<string, string[]>;
    resolvedAssignments: UniversalAssignmentSnapshot[];
  }>({
    queryKey: [`/api/admin/role-assignments/clients/${clientId}`],
    staleTime: 30_000,
  });

  const assignments = assignmentsQuery.data?.assignments ?? [];
  const allDepartments = assignmentsQuery.data?.departments ?? [];
  const membersByDept = assignmentsQuery.data?.membersByDept ?? {};
  const resolvedAssignments = assignmentsQuery.data?.resolvedAssignments ?? [];

  // Task #4171 — company-scope departments hold their roles once, company-wide;
  // they are not assignable per client, so this panel lists only client-facing
  // departments (with a pointer to the console when company ones exist).
  const departments = allDepartments.filter((d) => (d.assignmentScope ?? "per_client") !== "company");
  const companyDepartments = allDepartments.filter((d) => (d.assignmentScope ?? "per_client") === "company");

  const assignMap = new Map(assignments.map((a) => [a.departmentId, a]));
  const resolvedMap = new Map(resolvedAssignments.map((snapshot) => [snapshot.departmentId, snapshot]));

  const [editing, setEditing] = useState<string | null>(null);
  const [primaryUserId, setPrimaryUserId] = useState<string>("");
  const [checkerUserId, setCheckerUserId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  function startEdit(deptId: string) {
    const current = assignMap.get(deptId);
    setPrimaryUserId(current?.primaryUserId ?? "");
    setCheckerUserId(current?.checkerUserId ?? "");
    setEditing(deptId);
  }

  function cancelEdit() {
    setEditing(null);
    setPrimaryUserId("");
    setCheckerUserId("");
  }

  async function saveEdit(deptId: string) {
    setSaving(true);
    try {
      const department = departments.find((item) => item.id === deptId);
      const res = await apiRequest("PUT", `/api/admin/role-assignments/clients/${clientId}/departments/${deptId}`, {
        primaryUserId: primaryUserId || null,
        ...(department?.roleCapabilities?.checker === true ? { checkerUserId: checkerUserId || null } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Save failed");
      }
      const body = await res.json().catch(() => ({}));
      await queryClient.invalidateQueries({ queryKey: [`/api/admin/role-assignments/clients/${clientId}`] });
      // Task #5156 — surface projection feedback (pending/synced/blocked/etc.) after save.
      const projLabel = projectionToastLabel((body as any)?.projection);
      toast({ title: "Assignment saved", description: projLabel ?? undefined });
      cancelEdit();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function userName(userId: string | null | undefined): string {
    if (!userId) return "—";
    const u = allUsers.find((u) => u.id === userId);
    if (!u) return userId;
    return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || userId;
  }

  if (assignmentsQuery.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading assignments…</div>;
  }

  if (assignmentsQuery.isError) {
    return <div className="p-4 text-sm text-red-500">Failed to load assignments.</div>;
  }

  return (
    <div className="space-y-4" data-testid="client-sd-team-panel">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Client Role Assignments</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Effective department responsibilities. Explicit client assignments override inherited department defaults.
          </p>
        </div>
        <a
          href="/admin/role-assignments"
          className="text-xs underline text-primary-ink whitespace-nowrap"
          data-testid="link-role-assignments-client-detail"
        >
          Open company Role Assignments
        </a>
      </div>

      {departments.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          No active departments configured. Set them up in{" "}
          <a href="/admin/service-desk" className="underline text-primary-ink">Service Desk Settings</a>.
        </div>
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {departments.map((dept) => {
            const resolved = resolvedMap.get(dept.id);
            const isEditing = editing === dept.id;
            const hasCoverage = resolved?.roles.doer.eligibility === "eligible";

            return (
              <div key={dept.id} className="px-4 py-3" data-testid={`sd-dept-row-${dept.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{dept.name}</span>
                      {!hasCoverage && (
                        <span className="inline-flex items-center rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs text-amber-700" data-testid={`badge-no-coverage-${dept.id}`}>
                          No coverage
                        </span>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                        <ClientRoleValue
                          role="primary"
                          label="Doer"
                          departmentId={dept.id}
                          state={resolved?.roles.doer}
                          userName={userName}
                        />
                        {dept.roleCapabilities?.checker === true && (
                          <ClientRoleValue
                            role="checker"
                            label="Checker"
                            departmentId={dept.id}
                            state={resolved?.roles.checker}
                            userName={userName}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  {!isEditing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      onClick={() => startEdit(dept.id)}
                      data-testid={`button-edit-assignment-${dept.id}`}
                    >
                      Edit
                    </Button>
                  )}
                </div>

                {isEditing && (
                  <div className="mt-3 space-y-2" data-testid={`edit-form-${dept.id}`}>
                    {(() => {
                      const deptMemberIds = membersByDept[dept.id] ?? [];
                      const deptUsers = allUsers.filter((u) => deptMemberIds.includes(u.id));
                      const noMembers = deptUsers.length === 0;
                      return (
                        <>
                          {noMembers && (
                            <p className="text-xs text-amber-600">No active members in this department — add members in the Role Assignments console before assigning.</p>
                          )}
                    <div>
                      <Label htmlFor={`primary-${dept.id}`} className="text-xs">Doer</Label>
                      <Select
                        value={primaryUserId || SELECT_NONE_VALUE}
                        onValueChange={(v) => setPrimaryUserId(v === SELECT_NONE_VALUE ? "" : v)}
                      >
                        <SelectTrigger id={`primary-${dept.id}`} className="mt-1" data-testid={`select-primary-${dept.id}`}>
                          <SelectValue placeholder="None (use department default)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={SELECT_NONE_VALUE}>None (use department default)</SelectItem>
                          {deptUsers.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {dept.roleCapabilities?.checker === true && (
                      <div>
                        <Label htmlFor={`checker-${dept.id}`} className="text-xs">Checker</Label>
                        <Select
                          value={checkerUserId || SELECT_NONE_VALUE}
                          onValueChange={(v) => setCheckerUserId(v === SELECT_NONE_VALUE ? "" : v)}
                        >
                          <SelectTrigger id={`checker-${dept.id}`} className="mt-1" data-testid={`select-checker-${dept.id}`}>
                            <SelectValue placeholder="None (use department default)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SELECT_NONE_VALUE}>None (use department default)</SelectItem>
                            {deptUsers.map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                        </>
                      );
                    })()}
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => saveEdit(dept.id)}
                        disabled={saving}
                        data-testid={`button-save-assignment-${dept.id}`}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={cancelEdit}
                        disabled={saving}
                        data-testid={`button-cancel-assignment-${dept.id}`}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {companyDepartments.length > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-company-depts-pointer">
          Company-wide departments ({companyDepartments.map((d) => d.name).join(", ")}) hold one team for all clients —
          manage them in the{" "}
          <a href="/admin/role-assignments" className="underline text-primary-ink">
            Role Assignments console
          </a>
          .
        </p>
      )}
    </div>
  );
}

class CommandPanelErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[CommandPanel Error Boundary]", error, info.componentStack);
    console.error("[CommandPanel Error Boundary] error type:", typeof error, "name:", error?.name, "message:", error?.message, "stack:", error?.stack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg text-center" data-testid="command-panel-error">
          <p className="text-red-700 font-medium mb-2">Something went wrong loading the Command Panel</p>
          <p className="text-sm text-red-600 mb-3">{this.state.error?.message}</p>
          <button
            className="px-4 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700"
            onClick={() => this.setState({ hasError: false, error: null })}
            data-testid="button-retry-command-panel"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ClientDetail() {
  const { user, isLoading: authLoading } = useAuth();
  usePageTitle("Client Details");
  const params = useParams<{ id: string }>();
  const clientId = params.id;
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const searchParams = new URLSearchParams(searchString);
  const tabFromUrl = searchParams.get("tab");
  const initialTab = (tabFromUrl && TAB_MAP[tabFromUrl]) || "command-panel";

  const [activeTab, setActiveTab] = useState(initialTab);
  // Task #4038: allow deep links (e.g. the client list's "Budget missing"
  // badge) to pre-highlight a Command Panel section via ?highlight=<field>.
  const [highlightField, setHighlightField] = useState<string | null>(
    () => searchParams.get("highlight"),
  );
  const [prefillData, setPrefillData] = useState<Record<string, string> | null>(null);
  const [scrollToActionLogId, setScrollToActionLogId] = useState<string | null>(null);
  const [scrollToIntelligenceId, setScrollToIntelligenceId] = useState<string | null>(null);

  useEffect(() => {
    if (tabFromUrl && TAB_MAP[tabFromUrl]) {
      const resolvedTab = TAB_MAP[tabFromUrl];
      setActiveTab(resolvedTab);
      if (tabFromUrl !== resolvedTab) {
        const url = new URL(window.location.href);
        url.searchParams.set("tab", resolvedTab);
        window.history.replaceState(null, "", url.toString());
      }
    }
  }, [tabFromUrl]);

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, []);

  // Task #4349 — grouped navigation state. The active domain is DERIVED from
  // the leaf tab (so every ?tab= deep link keeps working untouched); clicking
  // a domain re-opens the last leaf visited inside it (first leaf initially).
  const activeDomainId = DOMAIN_BY_TAB[activeTab] ?? "overview";
  const lastLeafByDomain = useRef<Record<string, string>>({});
  useEffect(() => {
    const domainId = DOMAIN_BY_TAB[activeTab];
    if (domainId) lastLeafByDomain.current[domainId] = activeTab;
  }, [activeTab]);

  const handleDomainSelect = useCallback((domainId: string) => {
    const domain = TAB_DOMAINS.find((d) => d.id === domainId);
    if (!domain) return;
    const remembered = lastLeafByDomain.current[domainId];
    const target =
      remembered && domain.tabs.some((t) => t.id === remembered)
        ? remembered
        : domain.tabs[0].id;
    handleTabChange(target);
  }, [handleTabChange]);

  const handlePromoteToCommandPanel = useCallback((entry: any) => {
    const fieldMapping: Record<string, string> = {
      strategy_insight: "quarterPrimaryObjective",
      goal_change: "annualGoals",
      risk: "currentRiskFlags",
      opportunity: "currentOpportunities",
      budget_context: "productStatusNotes",
      client_preference: "clientPreferences",
      competitive_context: "activeCampaignFocus",
    };
    const targetField = fieldMapping[entry.entryType] || "quarterPrimaryObjective";
    setPrefillData({ [targetField]: entry.body || entry.title });
    setHighlightField(targetField);
    handleTabChange("command-panel");
    toast({ title: "Switched to Command Panel", description: "The relevant field has been highlighted and pre-filled." });
  }, [handleTabChange, toast]);

  const handleNavigateToActionLog = useCallback((actionLogId: string) => {
    setScrollToActionLogId(actionLogId);
    handleTabChange("action-log");
  }, [handleTabChange]);

  const handleNavigateToIntelligence = useCallback((entryId: string) => {
    setScrollToIntelligenceId(entryId);
    handleTabChange("intelligence");
  }, [handleTabChange]);

  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    firmName: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    consultType: "free",
    practiceAreas: [] as string[],
    ownerId: "",
    clientStartDate: "",
    averageCaseValue: 0,
    monthlyReviewTarget: 0,
    initialLeads: 0,
    initialReviews: 0,
    initialCases: 0,
    hasPostConsultReviewAccess: false,
    hasPostCaseClosedReviewAccess: false,
    hideOtherLeads: false,
    terminology: null as Record<string, string> | null,
    // Task #867 — comma- or newline-separated trusted domains. Held as a
    // free-text textarea while editing, normalised on save.
    emailDomainsText: "",
  });

  // Task #3711 — offboarding dialog state (final day of service picker).
  const [offboardDialogOpen, setOffboardDialogOpen] = useState(false);
  const [offboardDate, setOffboardDate] = useState("");


  const { data: clientSummary, isLoading: clientLoading, isSuccess: summaryReady } = useQuery<{
    client: Client;
    reports: Report[];
    dataAccess: { id: string; clientId: string; category: string; status: string; notes: string | null }[];
    contacts: ContactSummary[];
    offboarding: ClientOffboardingSummary | null;
  }>({
    queryKey: ["/api/clients", clientId, "summary"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/summary`, { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch client summary");
      return res.json();
    },
    enabled: !!user && !!clientId,
  });

  const client = clientSummary?.client;
  const reports = clientSummary?.reports;
  const offboarding = clientSummary?.offboarding ?? null;

  // Task #1941 — Audit history for this client (header popover).
  const clientAuditIds = clientId ? [clientId] : [];
  const { data: clientAuditMap } = useAuditHistory("client", clientAuditIds);
  const clientAuditEvents = clientId ? clientAuditMap?.[clientId] : undefined;

  const { data: users } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch("/api/users", { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    enabled: !!user && (user.role === "team_lead" || user.role === "ceo" || user.role === "account_manager"),
  });

  const { data: clientComms, isSuccess: commsReady } = useQuery<CommRecord[]>({
    queryKey: ["/api/clients", clientId, "communications", "zoom"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/communications?sourceType=zoom`, { credentials: "include", signal }, primaryQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch communications");
      return res.json();
    },
    enabled: !!user && !!clientId,
  });

  const primaryReady = summaryReady && commsReady;
  const deferredStep0 = useDeferredEnabled(primaryReady, 0);
  const deferredStep1 = useDeferredEnabled(primaryReady, 1);

  const { data: rerRecordings } = useQuery<RerRecording[]>({
    queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"],
    queryFn: async ({ signal }) => {
      const res = await throttledFetch(`/api/clients/${clientId}/command-panel/rer-recordings`, { credentials: "include", signal }, deferredQuerySemaphore);
      if (!res.ok) throw new Error("Failed to fetch RER recordings");
      return res.json();
    },
    enabled: !!user && !!clientId && deferredStep0,
    staleTime: CLIENT_HEAVY_QUERY_STALE_TIME_MS,
  });

  const [rerAssigning, setRerAssigning] = useState(false);
  const [rerSelectedComm, setRerSelectedComm] = useState("");
  const [rerSelectedMonth, setRerSelectedMonth] = useState("");
  const [rerDetailOpen, setRerDetailOpen] = useState<RerRecording | null>(null);

  const assignRerMutation = useMutation({
    mutationFn: async ({ rawCommunicationRecordId, reportingMonth }: { rawCommunicationRecordId: string; reportingMonth: string }) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/rer-recordings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ rawCommunicationRecordId, reportingMonth }),
      });
      if (!res.ok) throw new Error("Failed to add RER recording");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"] }); // fire-and-forget: cache refresh only
      toast({ title: "RER recording added" });
      setRerAssigning(false);
      setRerSelectedComm("");
      setRerSelectedMonth("");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add RER recording", description: err.message, variant: "destructive" });
    },
  });

  const removeRerMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/clients/${clientId}/command-panel/rer-recordings/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove RER recording");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "command-panel", "rer-recordings"] }); // fire-and-forget: cache refresh only
      toast({ title: "RER recording removed" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (
      // The PATCH /api/clients/:id endpoint accepts any subset of mutable
      // client fields. Most are mirrored in the local `formData` shape, but
      // `emailDomains` (Task #867 trusted-domain list) is derived from the
      // textarea on submit and isn't kept on the form. Allowing it as an
      // explicit optional sibling keeps the payload type-safe without an
      // `as any` escape.
      data: Partial<Omit<typeof formData, "emailDomainsText">> & { emailDomains?: string[] },
    ) => {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update client");
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      toast({ title: "Client updated successfully" });
      setEditDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to update client", variant: "destructive" });
    },
  });

  const openEditDialog = () => {
    if (client) {
      setFormData({
        firmName: client.firmName || "",
        contactName: client.contactName || "",
        contactEmail: client.contactEmail || "",
        contactPhone: client.contactPhone || "",
        consultType: client.consultType || "free",
        practiceAreas: client.practiceAreas || [],
        ownerId: client.ownerId || "",
        clientStartDate: client.clientStartDate ? client.clientStartDate.split("T")[0] : "",
        averageCaseValue: client.averageCaseValue || 0,
        monthlyReviewTarget: client.monthlyReviewTarget || 0,
        initialLeads: client.initialLeads || 0,
        initialReviews: client.initialReviews || 0,
        initialCases: client.initialCases || 0,
        hasPostConsultReviewAccess: client.hasPostConsultReviewAccess || false,
        hasPostCaseClosedReviewAccess: client.hasPostCaseClosedReviewAccess || false,
        hideOtherLeads: client.hideOtherLeads || false,
        terminology: (client.terminology || {}) as Record<string, string>,
        emailDomainsText: Array.isArray(client.emailDomains) ? client.emailDomains.join(", ") : "",
      });
      setEditDialogOpen(true);
    }
  };
  
  const archiveMutation = useMutation({
    mutationFn: async (isArchived: boolean) => {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isArchived }),
      });
      if (!res.ok) throw new Error("Failed to update client");
      return res.json();
    },
    onSuccess: (_, isArchived) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      toast({ title: isArchived ? "Client archived" : "Client restored" });
    },
    onError: () => {
      toast({ title: "Failed to update client", variant: "destructive" });
    },
  });

  // CEO-only demo-account flag. Demo clients are excluded from the churn
  // views and dashboard aggregations server-side, so flipping this removes
  // the client from the Churn Command Center — invalidate its cache too.
  const demoMutation = useMutation({
    mutationFn: async (isDemo: boolean) => {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ isDemo }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err.error || "Failed to update client");
      }
      return res.json();
    },
    onSuccess: (_, isDemo) => {
      // Intentional fire-and-forget cache fan-out (file convention): refetch
      // failures surface in query state, not here.
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/churn/leaderboard"] });
      toast({
        title: isDemo ? "Marked as demo account" : "Demo flag removed",
        description: isDemo
          ? "This client is now hidden from churn and dashboard views."
          : "This client will reappear in churn and dashboard views.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update demo flag", description: err.message, variant: "destructive" });
    },
  });

  // Task #3711 — schedule/reschedule/cancel a client offboarding. On the
  // final day of service the daily sweep auto-archives the client, so these
  // mutations invalidate the same caches the archive mutation does.
  const scheduleOffboardMutation = useMutation({
    mutationFn: async (finalServiceDate: string) => {
      const res = await fetch(`/api/clients/${clientId}/offboarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ finalServiceDate }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err.error || "Failed to schedule offboarding");
      }
      return res.json() as Promise<{ offboarding: ClientOffboardingSummary; action: "initiated" | "rescheduled" }>;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      toast({
        title: data.action === "initiated" ? "Offboarding scheduled" : "Offboarding date updated",
        description: `${client?.firmName ?? "Client"} will be automatically archived on ${formatFinalServiceDay(data.offboarding.finalServiceDate)}.`,
      });
      setOffboardDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to schedule offboarding", description: err.message, variant: "destructive" });
    },
  });

  const cancelOffboardMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clients/${clientId}/offboarding`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any));
        throw new Error(err.error || "Failed to cancel offboarding");
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/clients"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/dashboard/client-summaries"] }); // fire-and-forget: cache refresh only
      toast({ title: "Offboarding cancelled", description: "The client will not be auto-archived." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to cancel offboarding", description: err.message, variant: "destructive" });
    },
  });

  const deleteReportMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const res = await fetch(`/api/reports/${reportId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete report");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      toast({ title: "Report deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete report", variant: "destructive" });
    },
  });
  
  const setDemoReportMutation = useMutation({
    mutationFn: async (reportId: string) => {
      const res = await fetch("/api/admin/demo-report-setting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reportId }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to set demo report");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Demo report updated", description: "This report will now appear on the demo page." });
    },
    onError: (error: Error) => {
      toast({ 
        title: "Failed to set demo report", 
        description: error.message.includes("relation") 
          ? "Database needs update. Please republish the app." 
          : error.message,
        variant: "destructive" 
      });
    },
  });
  
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false);
  const [duplicateReportId, setDuplicateReportId] = useState<string | null>(null);
  const [duplicateTargetMonth, setDuplicateTargetMonth] = useState("");
  
  const duplicateReportMutation = useMutation({
    mutationFn: async ({ reportId, targetMonth }: { reportId: string; targetMonth: string }) => {
      const res = await fetch(`/api/reports/${reportId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ targetMonth }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to duplicate report");
      }
      return res.json();
    },
    onSuccess: (newReport) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/clients", clientId, "summary"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/reports/matrix"] }); // fire-and-forget: cache refresh only
      toast({ title: "Report duplicated" });
      setDuplicateDialogOpen(false);
      setDuplicateReportId(null);
      setDuplicateTargetMonth("");
      // Navigate to the new report
      navigate(`/reports/${newReport.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to duplicate report", description: error.message, variant: "destructive" });
    },
  });


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.firmName.trim()) {
      toast({ title: "Firm name is required", variant: "destructive" });
      return;
    }
    // Task #867 — split the textarea into a clean string[] of trusted
    // domains. Backend re-normalises (lowercases, strips `@`, dedupes) but
    // we still tidy here so the UI shows what the server stored.
    const emailDomains = (formData.emailDomainsText || "")
      .split(/[\s,;\n]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter((d) => d.length > 0 && d.includes("."));
    const { emailDomainsText: _omit, ...rest } = formData;
    updateMutation.mutate({ ...rest, emailDomains });
  };

  if (authLoading || clientLoading) {
    return <ClientDetailSkeleton />;
  }

  if (!user) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-muted-foreground">Please log in to view this page.</p>
      </div>
    );
  }

  if (!client) {
    return (
      <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 flex items-center justify-center">
        <p className="text-foreground">Client not found.</p>
      </div>
    );
  }

  const formatMonth = (month: string) => {
    try {
      const [year, monthNum] = month.split("-");
      return format(new Date(parseInt(year), parseInt(monthNum) - 1), "MMMM yyyy");
    } catch {
      return month;
    }
  };


  const allUsers = users || [];

  // Task #5010 — the summary payload's reports arrive newest-first (server
  // orders by reportMonth desc), so [0] is the client's most recent report.
  const latestReport = reports?.[0];

  return (
    <div className="min-h-[calc(100dvh-var(--nav-height))] bg-surface-warm-1 p-4 sm:p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="bg-card rounded-xl shadow-sm border border-primary/8 px-5 py-4 sm:px-6 sm:py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              <Button asChild variant="ghost" size="icon" className="shrink-0 h-9 w-9 rounded-lg border border-primary/10 hover:bg-primary/5 hover:border-primary/20 transition-colors" aria-label="Back to client list" data-testid="button-back">
                <Link href="/">
                  <ArrowLeft className="w-4 h-4 text-primary" />
                </Link>
              </Button>
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">{client.firmName}</h1>
                  {clientId && (
                    <AuditHistoryPopover
                      entity="client"
                      targetId={clientId}
                      events={clientAuditEvents}
                    />
                  )}
                  {(() => {
                    const code = client.clientCode;
                    const display = code || (clientId ? `ID: ${clientId.slice(0, 8)}` : "");
                    const copyValue = code || clientId || "";
                    const tooltip = code
                      ? `Click to copy client code: ${code}\n(Internal ID: ${clientId})`
                      : `Click to copy client ID: ${clientId}`;
                    return (
                      <button
                        type="button"
                        onClick={() => {
                          if (!copyValue) return;
                          navigator.clipboard.writeText(copyValue).then(
                            () => toast({ title: code ? "Client code copied" : "Client ID copied", description: copyValue }),
                            () => toast({ title: "Copy failed", description: copyValue, variant: "destructive" })
                          );
                        }}
                        title={tooltip}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground text-[11px] font-mono rounded-full border border-border transition-colors whitespace-nowrap"
                        data-testid="badge-client-id"
                      >
                        <span>{display}</span>
                        <Copy className="w-3 h-3" />
                      </button>
                    );
                  })()}
                  {client.isArchived && (
                    <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-xs font-semibold rounded-full border border-amber-200 whitespace-nowrap">Archived</span>
                  )}
                  {client.isDemo && (
                    <span className="px-2 py-0.5 bg-purple-50 text-purple-700 text-xs font-semibold rounded-full border border-purple-200 whitespace-nowrap" data-testid="badge-demo-client">
                      Demo Account
                    </span>
                  )}
                  {!client.isArchived && offboarding && (
                    <span className="px-2 py-0.5 bg-orange-50 text-orange-700 text-xs font-semibold rounded-full border border-orange-200 whitespace-nowrap" data-testid="badge-offboarding">
                      Offboarding — final day {formatFinalServiceDay(offboarding.finalServiceDate)}
                    </span>
                  )}
                  {client.ownerId && (() => {
                    const owner = users?.find(u => u.id === client.ownerId);
                    const ownerName = owner ? `${owner.firstName || ''} ${owner.lastName || ''}`.trim() || owner.email : null;
                    const isMyClient = client.ownerId === user.id;
                    return ownerName ? (
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${isMyClient ? "bg-primary/10 text-primary" : "bg-blue-50 text-blue-600 border border-blue-200"}`} data-testid="badge-owner">
                        {ownerName}{isMyClient ? " (You)" : ""}
                      </span>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 min-w-0 sm:shrink-0">
              {/* Task #4305 — one-click Text/Call into the Conversation Hub,
                  available from every tab. Number resolution + no-phone hint
                  live in the shared component. */}
              {clientId && (
                <ClientCommsQuickActions
                  clientId={clientId}
                  contactName={client.contactName}
                  contactPhone={client.contactPhone}
                  contacts={clientSummary?.contacts}
                />
              )}
              {/* Task #5010 — one-click jump to this client's Reports tab from
                  any tab (operators kept detouring through the all-reports
                  page). Routes through handleTabChange so the ?tab=reports
                  shareable-URL contract keeps working. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleTabChange("reports")}
                className="border-primary/15 text-primary-ink hover:bg-primary/5 hover:border-primary/25 transition-colors"
                aria-label="Open client reports"
                data-testid="button-quick-reports"
              >
                <FileText className="w-3.5 h-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Reports</span>
              </Button>
              <Button
                asChild
                variant="outline"
                size="sm"
                className="border-primary/15 text-primary-ink hover:bg-primary/5 hover:border-primary/25 transition-colors"
                data-testid="button-create-service-request"
              >
                <Link href={`/service-desk/create?clientName=${encodeURIComponent(client.firmName)}&clientId=${encodeURIComponent(clientId ?? "")}`}>
                  <TicketCheck className="w-3.5 h-3.5 mr-1.5" />
                  <span className="hidden sm:inline">Request</span>
                </Link>
              </Button>
              <Button variant="outline" size="sm" onClick={openEditDialog} className="border-primary/15 text-primary-ink hover:bg-primary/5 hover:border-primary/25 transition-colors" data-testid="button-edit-client">
                <Pencil className="w-3.5 h-3.5 mr-1.5" />
                Edit
              </Button>
              {/* Task #4349 (P1-7) — destructive actions (Archive, Demo toggle,
                  Offboard) moved out of this routine row into the DangerZone at
                  the bottom of the Overview tab. */}
            </div>
          </div>
        </div>

        {/* Task #3711 — offboarding dialog: pick the final day of service. */}
        <Dialog open={offboardDialogOpen} onOpenChange={setOffboardDialogOpen}>
          <DialogContent className="max-w-md" data-testid="dialog-offboard">
            <DialogHeader>
              <DialogTitle>{offboarding ? "Change final day of service" : "Initiate offboarding"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Pick the final day of service for <span className="font-medium text-foreground">{client.firmName}</span>.
                On that day the morning sweep automatically archives the client — it drops out of the default
                client list and dashboards exactly like a manual archive. You can change the date or cancel
                the offboard any time before then.
              </p>
              <div>
                <Label htmlFor="offboardDate">Final day of service</Label>
                <Input
                  id="offboardDate"
                  type="date"
                  min={new Date().toLocaleDateString("en-CA")}
                  value={offboardDate}
                  onChange={(e) => setOffboardDate(e.target.value)}
                  data-testid="input-offboard-date"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setOffboardDialogOpen(false)} data-testid="button-offboard-back">
                  Back
                </Button>
                <Button
                  onClick={() => offboardDate && scheduleOffboardMutation.mutate(offboardDate)}
                  disabled={!offboardDate || scheduleOffboardMutation.isPending}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                  data-testid="button-confirm-offboard"
                >
                  <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
                  {offboarding ? "Update Date" : "Schedule Offboard"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full" data-testid="client-command-tabs">
          {/* Task #4349 — grouped navigation (P0-2): one row of six domains,
              then the active domain's sub-tabs. Grouping + per-tab study:
              audits/client-panel-tab-inventory-2026-08.md. Every leaf
              TabsTrigger stays MOUNTED (inactive sub-rows are CSS-hidden, not
              unmounted) so ?tab= deep links, the tab-<id> testid contract, and
              Radix tab state keep working unchanged. */}
          <div className="bg-card/90 backdrop-blur-sm border border-primary/8 rounded-xl shadow-sm">
            <div className="flex items-stretch gap-1 overflow-x-auto p-1.5" role="group" aria-label="Client panel sections">
              {TAB_DOMAINS.map((domain) => {
                const DomainIcon = domain.icon;
                const isActiveDomain = activeDomainId === domain.id;
                return (
                  <button
                    key={domain.id}
                    type="button"
                    onClick={() => handleDomainSelect(domain.id)}
                    aria-current={isActiveDomain ? "true" : undefined}
                    className={`inline-flex min-h-[40px] items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-all ${
                      isActiveDomain
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-primary-ink/60 hover:bg-primary/5 hover:text-primary-ink"
                    }`}
                    data-testid={`tabgroup-${domain.id}`}
                  >
                    <DomainIcon className="h-4 w-4" />
                    {domain.label}
                  </button>
                );
              })}
            </div>
            {TAB_DOMAINS.filter((domain) => domain.tabs.length > 1).map((domain) => (
              <TabsList
                key={domain.id}
                className={`${
                  activeDomainId === domain.id ? "flex" : "hidden"
                } h-auto w-full items-center justify-start gap-1 overflow-x-auto rounded-none rounded-b-xl border-t border-primary/8 bg-transparent p-1.5`}
                data-testid={`subtabs-${domain.id}`}
              >
                {domain.tabs.map((tab) => {
                  const TabIcon = tab.icon;
                  return (
                    <TabsTrigger
                      key={tab.id}
                      value={tab.id}
                      className="min-h-[36px] rounded-lg border-b-2 border-transparent px-3 py-1.5 text-xs font-medium text-primary-ink/60 transition-all hover:bg-primary/5 hover:text-primary-ink data-[state=active]:border-primary-ink data-[state=active]:bg-primary/10 data-[state=active]:text-primary-ink data-[state=active]:shadow-none lg:text-sm"
                      data-testid={`tab-${tab.id}`}
                    >
                      <TabIcon className="mr-1 h-3.5 w-3.5" />
                      {tab.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            ))}
            {/* Single-leaf domains (Overview): the leaf trigger must stay in the
                DOM for the deep-link/testid contract, but the domain button IS
                the visible control — never show this list. */}
            {TAB_DOMAINS.filter((domain) => domain.tabs.length === 1).map((domain) => (
              <TabsList key={domain.id} className="hidden" aria-hidden="true" tabIndex={-1}>
                {domain.tabs.map((tab) => (
                  <TabsTrigger key={tab.id} value={tab.id} data-testid={`tab-${tab.id}`}>
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            ))}
          </div>

          <TabsContent value="command-panel" className="space-y-6 mt-4 data-[state=inactive]:hidden" forceMount>
            {/* Task #5010 — latest-report quick access on the default view
                (sibling of the Command Panel, never inside it). Link semantics
                mirror the Reports tab rows: final + shareToken → share view,
                otherwise preview. Empty list renders a low-key pointer toward
                report creation instead of a dead card. */}
            <Card className="bg-card border-primary/10" data-testid="card-latest-report">
              <CardContent className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                  {latestReport ? (
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        Latest report — {formatMonth(latestReport.reportMonth)}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">{latestReport.status}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-no-reports-hint">
                      No reports yet —{" "}
                      <Link
                        href={`/reports/new?clientId=${clientId}`}
                        className="font-medium text-primary hover:underline"
                        data-testid="link-create-first-report"
                      >
                        create the first report
                      </Link>
                    </p>
                  )}
                </div>
                {latestReport && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button asChild variant="outline" size="sm" className="h-7 text-xs" data-testid="button-view-latest-report">
                      <Link href={latestReport.status === "final" && latestReport.shareToken ? `/share/${latestReport.shareToken}` : `/preview/${latestReport.id}`}>
                        <Eye className="w-3 h-3 mr-1" />
                        {latestReport.status === "final" ? "View" : "Preview"}
                      </Link>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-primary-ink/70 hover:bg-primary/5 hover:text-primary-ink"
                      onClick={() => handleTabChange("reports")}
                      data-testid="button-see-all-reports"
                    >
                      See all reports
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
            <CommandPanelErrorBoundary>
              <CommandPanel
                clientId={clientId!}
                client={client!}
                currentUser={user as any}
                allUsers={allUsers}
                highlightField={highlightField}
                prefillData={prefillData}
                onEditClient={openEditDialog}
                onUpdateClient={(data) => updateMutation.mutate(data)}
                primaryReady={primaryReady}
              />
            </CommandPanelErrorBoundary>
            {/* Task #4327 — deals pipeline entry point from the client page. */}
            <ClientDealsCard clientId={clientId!} />
            {/* Task #4329 — manual + rule tags on the client. */}
            <RecordTagsCard entityType="client" recordId={clientId!} />
            {/* Task #4349 (P1-7) — destructive account-state actions live in
                the shared DangerZone, separated from the routine header row.
                Role gates match the old header buttons exactly; the offboard
                flow reuses the page-level date dialog below. */}
            {(user.role === "team_lead" || user.role === "ceo" || user.role === "admin") && (
              <DangerZone
                description={`Account-level state changes for ${client.firmName}. These change dashboard, churn, and visibility behavior across the OS.`}
                testId="client-danger-zone"
              >
                {client.isArchived ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => archiveMutation.mutate(false)}
                    disabled={archiveMutation.isPending}
                    className="border-primary/15 text-primary-ink hover:bg-primary/5 hover:border-primary/25 transition-colors"
                    data-testid="button-archive-client"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5 mr-1.5" />
                    Restore
                  </Button>
                ) : (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={archiveMutation.isPending}
                        className="border-status-critical/40 text-status-critical hover:bg-status-critical/5 transition-colors"
                        data-testid="button-archive-client"
                      >
                        <Archive className="w-3.5 h-3.5 mr-1.5" />
                        Archive
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent data-testid="dialog-archive-confirm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Archive {client.firmName}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The client drops out of the default client list and dashboards.
                          You can restore it from this panel at any time.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="button-archive-cancel">Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => archiveMutation.mutate(true)} data-testid="button-archive-confirm">
                          Archive
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                {/* CEO-only demo-account toggle: demo clients are excluded from
                    churn + dashboard views server-side (PATCH gate matches). */}
                {user.role === "ceo" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => demoMutation.mutate(!client.isDemo)}
                    disabled={demoMutation.isPending}
                    className="border-purple-200 text-purple-700 hover:bg-purple-50 transition-colors"
                    data-testid="button-toggle-demo-client"
                  >
                    <FlaskConical className="w-3.5 h-3.5 mr-1.5" />
                    {client.isDemo ? "Unmark Demo" : "Mark as Demo"}
                  </Button>
                )}
                {/* Task #3711 — schedule/cancel offboarding (auto-archive on
                    final service day). Same role gate as Archive. */}
                {!client.isArchived && (
                  offboarding ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setOffboardDate(offboarding.finalServiceDate); setOffboardDialogOpen(true); }}
                        className="border-orange-300 text-orange-700 hover:bg-orange-50 transition-colors"
                        data-testid="button-change-offboard-date"
                      >
                        <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
                        Change Date
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => cancelOffboardMutation.mutate()}
                        disabled={cancelOffboardMutation.isPending}
                        className="border-orange-300 text-orange-700 hover:bg-orange-50 transition-colors"
                        data-testid="button-cancel-offboard"
                      >
                        <X className="w-3.5 h-3.5 mr-1.5" />
                        Cancel Offboard
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setOffboardDate(""); setOffboardDialogOpen(true); }}
                      className="border-status-critical/40 text-status-critical hover:bg-status-critical/5 transition-colors"
                      data-testid="button-initiate-offboard"
                    >
                      <CalendarClock className="w-3.5 h-3.5 mr-1.5" />
                      Initiate Offboard
                    </Button>
                  )
                )}
              </DangerZone>
            )}
          </TabsContent>

          <TabsContent value="intelligence" className="mt-4">
            <IntelligenceFeed
              clientId={clientId!}
              currentUser={user as any}
              onPromoteToCommandPanel={handlePromoteToCommandPanel}
              onNavigateToActionLog={handleNavigateToActionLog}
              scrollToEntryId={scrollToIntelligenceId}
            />
          </TabsContent>

          <TabsContent value="action-log" className="mt-4">
            <ActionLog
              clientId={clientId!}
              currentUser={user as any}
              onNavigateToIntelligence={handleNavigateToIntelligence}
              scrollToEntryId={scrollToActionLogId}
            />
          </TabsContent>

          <TabsContent value="comm-log" className="mt-4">
            <RawCommunicationLog
              clientId={clientId!}
              currentUser={user as any}
            />
          </TabsContent>

          {/* Task #4328 — unified activity timeline (email/SMS/calls/meetings/tickets/notes) */}
          <TabsContent value="timeline" className="mt-4">
            <ClientTimeline
              endpoint={`/api/clients/${clientId}/timeline`}
              noteClientId={clientId}
            />
          </TabsContent>

          <TabsContent value="local-dominance" className="mt-4">
            <LocalDominanceDashboard
              clientId={clientId!}
              userRole={(user as any)?.role}
            />
          </TabsContent>
          <TabsContent value="matching-agent" className="space-y-6 mt-4">
            <div className="grid gap-6 md:grid-cols-2">
              <MatchingContactsSummary contacts={clientSummary?.contacts} isLoading={clientLoading} onNavigate={() => handleTabChange("command-panel")} clientId={clientId ?? undefined} />
              <AgentProfile clientId={clientId!} />
            </div>
            <MatchDecisionAudit clientId={clientId!} />
          </TabsContent>

          <TabsContent value="daily-judgment" className="mt-4">
            <DailyJudgmentStream
              clientId={clientId!}
              currentUser={user as { id: string; firstName: string | null; lastName: string | null; email: string | null; role: string | null }}
            />
          </TabsContent>

          <TabsContent value="agent-chat" className="mt-4">
            <ClientAgentChat clientId={clientId!} />
          </TabsContent>

          <TabsContent value="agent-memory" className="mt-4">
            <AgentKnowledgePanel clientId={clientId!} />
          </TabsContent>

          <TabsContent value="files" className="mt-4">
            {clientId && <ClientFilesTab clientId={clientId} />}
          </TabsContent>

          <TabsContent value="reports" className="mt-4">
            <div className="space-y-6">
              {/* RER Recordings Section */}
              <Card className="bg-card border-primary/10" data-testid="card-rer-recordings">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-foreground flex items-center gap-2">
                      <Calendar className="w-5 h-5" />
                      RER Recordings
                      {rerRecordings && rerRecordings.length > 0 && (
                        <Badge className="bg-primary/10 text-primary text-xs">{rerRecordings.length}</Badge>
                      )}
                    </CardTitle>
                    {(user.role === "ceo" || user.role === "team_lead" || user.role === "admin" || user.role === "account_manager") && !rerAssigning && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs border-primary/20 text-primary-ink"
                        onClick={() => setRerAssigning(true)}
                        data-testid="button-add-rer"
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" /> Add RER
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Monthly report review recordings linked to report months</p>
                </CardHeader>
                <CardContent>
                  {rerAssigning && (
                    <div className="border rounded-lg p-4 space-y-3 bg-surface-warm-1/30 mb-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1 block">Recording</Label>
                          <Select value={rerSelectedComm} onValueChange={setRerSelectedComm}>
                            <SelectTrigger className="h-8 text-xs" data-testid="select-rer-comm">
                              <SelectValue placeholder="Select recording..." />
                            </SelectTrigger>
                            <SelectContent>
                              {(clientComms || []).map((c) => (
                                <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground mb-1 block">Report Month</Label>
                          <Input
                            value={rerSelectedMonth}
                            onChange={(e) => setRerSelectedMonth(e.target.value)}
                            placeholder="e.g. 2026-03 or March 2026"
                            className="h-8 text-xs"
                            data-testid="input-rer-month"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="h-7 text-xs bg-primary hover:bg-primary/90"
                          disabled={!rerSelectedComm || !rerSelectedMonth || assignRerMutation.isPending}
                          onClick={() => assignRerMutation.mutate({ rawCommunicationRecordId: rerSelectedComm, reportingMonth: rerSelectedMonth })}
                          data-testid="button-confirm-rer"
                        >
                          <Check className="w-3 h-3 mr-1" /> Add Recording
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setRerAssigning(false); setRerSelectedComm(""); setRerSelectedMonth(""); }}>
                          <X className="w-3 h-3 mr-1" /> Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {(!rerRecordings || rerRecordings.length === 0) && !rerAssigning ? (
                    <p className="text-sm text-muted-foreground/70 text-center py-6">No RER recordings linked yet</p>
                  ) : rerRecordings && rerRecordings.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {rerRecordings.map((rer) => (
                        <div
                          key={rer.id}
                          className="group relative p-4 bg-surface-warm-1/60 rounded-xl border border-primary/8 hover:border-primary/20 transition-colors"
                          data-testid={`rer-row-${rer.id}`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <Badge className="bg-primary/10 text-primary text-xs font-medium">
                              {rer.reportingMonth}
                            </Badge>
                            {(user.role === "ceo" || user.role === "team_lead" || user.role === "admin" || user.role === "account_manager") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => removeRerMutation.mutate(rer.id)}
                                data-testid={`button-remove-rer-${rer.id}`}
                              >
                                <Trash2 className="w-3 h-3 text-red-400" />
                              </Button>
                            )}
                          </div>
                          <button
                            className="text-sm font-medium text-primary-ink hover:underline text-left w-full truncate block"
                            onClick={() => setRerDetailOpen(rer)}
                            data-testid={`button-view-rer-${rer.id}`}
                          >
                            {rer.communication?.title || "Unknown Recording"}
                          </button>
                          <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground/70">
                            <Video className="w-3 h-3" />
                            {rer.communication?.timestamp ? format(new Date(rer.communication.timestamp), "MMM d, yyyy") : "—"}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              {/* Monthly Reports */}
              <Card className="bg-card border-primary/10" data-testid="card-reports">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-foreground flex items-center gap-2">
                        <FileText className="w-5 h-5" />
                        Monthly Reports
                      </CardTitle>
                      <p className="text-xs text-muted-foreground mt-1">Performance reports for this client</p>
                    </div>
                    <Button asChild size="sm" className="bg-primary hover:bg-primary/90" data-testid="button-new-report">
                      <Link href={`/reports/new?clientId=${clientId}`}>
                        <Plus className="w-4 h-4 mr-1" />
                        New Report
                      </Link>
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {!reports || reports.length === 0 ? (
                    <div className="text-center py-8">
                      <FileText className="w-10 h-10 mx-auto text-primary/20 mb-3" />
                      <p className="text-muted-foreground text-sm">No reports yet. Create your first report!</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {reports.map(report => {
                        const hasRer = rerRecordings?.some(r => r.reportingMonth === report.reportMonth);
                        return (
                          <div 
                            key={report.id} 
                            className="flex items-center justify-between p-3 bg-surface-warm-1/60 rounded-lg border border-primary/5 hover:border-primary/15 transition-colors"
                            data-testid={`row-report-${report.id}`}
                          >
                            <div className="flex items-center gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-foreground">{formatMonth(report.reportMonth)}</p>
                                  {hasRer && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-caption font-medium bg-primary/10 text-primary" title="RER recording exists for this month">
                                      <Video className="w-2.5 h-2.5" />
                                      RER
                                    </span>
                                  )}
                                  {/* Task #4537 — operator "Presented / Delivered" mark */}
                                  {report.presentedAt && (
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800"
                                      title={`Presented/Delivered ${new Date(report.presentedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
                                      data-testid={`badge-presented-${report.id}`}
                                    >
                                      <Check className="w-2.5 h-2.5" />
                                      Presented
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground capitalize">{report.status}</p>
                              </div>
                            </div>
                            <div className="flex gap-1.5">
                              <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                                <Link href={`/reports/${report.id}`}>Edit</Link>
                              </Button>
                              <Button asChild variant="outline" size="sm" className="h-7 text-xs" data-testid={`button-view-report-${report.id}`}>
                                <Link href={report.status === "final" && report.shareToken ? `/share/${report.shareToken}` : `/preview/${report.id}`}>
                                  <Eye className="w-3 h-3 mr-1" />
                                  {report.status === "final" ? "View" : "Preview"}
                                </Link>
                              </Button>
                              <Button 
                                variant="outline" 
                                size="sm"
                                className="h-7 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                onClick={() => {
                                  setDuplicateReportId(report.id);
                                  const [year, month] = report.reportMonth.split("-").map(Number);
                                  const nextMonth = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
                                  setDuplicateTargetMonth(nextMonth);
                                  setDuplicateDialogOpen(true);
                                }}
                                data-testid={`button-duplicate-report-${report.id}`}
                              >
                                <Copy className="w-3 h-3" />
                              </Button>
                              {user.role === "ceo" && (
                                <ConfirmActionDialog
                                  title="Set this report as the demo report?"
                                  description="This report becomes the sanitized example shown on the public demo page, replacing the current demo report. You can pick a different report later."
                                  confirmLabel="Set as demo"
                                  testId={`dialog-confirm-set-demo-${report.id}`}
                                  onConfirm={() => setDemoReportMutation.mutate(report.id)}
                                  trigger={
                                    <Button 
                                      variant="outline" 
                                      size="sm"
                                      className="h-7 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                      disabled={setDemoReportMutation.isPending}
                                      data-testid={`button-set-demo-${report.id}`}
                                      title="Set as Demo Report"
                                    >
                                      <Star className="w-3 h-3" />
                                    </Button>
                                  }
                                />
                              )}
                              {/* Task #4644: report deletion is team-lead+ on the server */}
                              {(user.role === "team_lead" || user.role === "ceo") && (
                                <ConfirmActionDialog
                                  title="Delete this report?"
                                  description="The report and all metrics entered in it are permanently deleted, including any client-facing view. This cannot be undone."
                                  confirmLabel="Delete report"
                                  testId={`dialog-confirm-delete-report-${report.id}`}
                                  onConfirm={() => deleteReportMutation.mutate(report.id)}
                                  trigger={
                                    <Button 
                                      variant="outline" 
                                      size="sm"
                                      className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                                      disabled={deleteReportMutation.isPending}
                                      data-testid={`button-delete-report-${report.id}`}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  }
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* RER Detail Dialog */}
            <Dialog open={!!rerDetailOpen} onOpenChange={() => setRerDetailOpen(null)}>
              <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-foreground">{rerDetailOpen?.communication?.title || "RER Recording"}</DialogTitle>
                </DialogHeader>
                {rerDetailOpen?.communication && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Badge variant="outline" className="text-xs">{rerDetailOpen.reportingMonth}</Badge>
                      {rerDetailOpen.communication.timestamp && (
                        <span>{format(new Date(rerDetailOpen.communication.timestamp), "MMM d, yyyy h:mm a")}</span>
                      )}
                    </div>
                    {rerDetailOpen.communication.aiSummary && (
                      <div className="p-3 bg-purple-50 border border-purple-100 rounded">
                        <div className="flex items-center gap-1 text-purple-700 font-medium text-sm mb-1">
                          <Sparkles className="w-3.5 h-3.5" /> AI Summary
                        </div>
                        <p className="text-sm text-purple-900 whitespace-pre-wrap">{rerDetailOpen.communication.aiSummary}</p>
                      </div>
                    )}
                    {rerDetailOpen.communication.contentText && (
                      <div className="p-3 bg-muted/50 border border-border rounded max-h-96 overflow-y-auto">
                        <p className="text-sm text-muted-foreground font-medium mb-2">Transcript</p>
                        <pre className="text-sm text-foreground whitespace-pre-wrap font-sans">{rerDetailOpen.communication.contentText}</pre>
                      </div>
                    )}
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="billing" className="mt-4">
            <BillingSection clientId={clientId!} />
          </TabsContent>


          <TabsContent value="scheduling" className="mt-4">
            <ClientSchedulingPanel
              clientId={clientId!}
              defaultInviteeEmail={client?.contactEmail || ""}
              defaultInviteeName={client?.firmName || ""}
            />
          </TabsContent>
          <TabsContent value="live-data" className="mt-4">
            <LiveDataTab
              clientId={clientId!}
              canManage={
                user?.role === "ceo" ||
                user?.role === "team_lead" ||
                user?.role === "admin"
              }
            />
          </TabsContent>

          <TabsContent value="team-chat" className="mt-4">
            <ClientCommsChatterFeed
              clientId={clientId!}
              clientName={client?.firmName ?? "this client"}
            />
          </TabsContent>

          <TabsContent value="sd-team" className="mt-4">
            <ClientSdTeamPanel clientId={clientId!} allUsers={allUsers} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Client</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="firmName">Firm Name *</Label>
              <Input
                id="firmName"
                value={formData.firmName}
                onChange={e => setFormData(prev => ({ ...prev, firmName: e.target.value }))}
                required
                data-testid="input-firm-name"
              />
            </div>
            <div>
              <Label htmlFor="contactName">Contact Name</Label>
              <Input
                id="contactName"
                value={formData.contactName}
                onChange={e => setFormData(prev => ({ ...prev, contactName: e.target.value }))}
                data-testid="input-contact-name"
              />
            </div>
            <div>
              <Label htmlFor="contactEmail">Contact Email</Label>
              <Input
                id="contactEmail"
                type="email"
                value={formData.contactEmail}
                onChange={e => setFormData(prev => ({ ...prev, contactEmail: e.target.value }))}
                data-testid="input-contact-email"
              />
            </div>
            <div>
              <Label htmlFor="emailDomains">Trusted Email Domains</Label>
              <textarea
                id="emailDomains"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="acme.com, partner-firm.com"
                value={formData.emailDomainsText}
                onChange={e => setFormData(prev => ({ ...prev, emailDomainsText: e.target.value }))}
                data-testid="input-email-domains"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Comma- or newline-separated. Front emails from any of these domains will auto-match to this client (Task #867 hard-match rule). Public free-mail providers (gmail, hotmail, …) and your firm's own internal domain are ignored.
              </p>
            </div>
            <div>
              <Label htmlFor="contactPhone">Contact Phone</Label>
              <Input
                id="contactPhone"
                value={formData.contactPhone}
                onChange={e => setFormData(prev => ({ ...prev, contactPhone: e.target.value }))}
                data-testid="input-contact-phone"
              />
            </div>
            <div>
              <Label htmlFor="clientStartDate">Client Start Date</Label>
              <Input
                id="clientStartDate"
                type="date"
                value={formData.clientStartDate}
                onChange={e => setFormData(prev => ({ ...prev, clientStartDate: e.target.value }))}
                data-testid="input-client-start-date"
              />
              <p className="text-xs text-muted-foreground mt-1">When did this client relationship begin?</p>
            </div>
            <div>
              <Label htmlFor="averageCaseValue">Average Case Value ($)</Label>
              <Input
                id="averageCaseValue"
                type="number"
                min="0"
                value={formData.averageCaseValue}
                onChange={e => setFormData(prev => ({ ...prev, averageCaseValue: parseInt(e.target.value) || 0 }))}
                data-testid="input-average-case-value"
              />
            </div>
            <div>
              <Label htmlFor="monthlyReviewTarget">Monthly Review Target</Label>
              <Input
                id="monthlyReviewTarget"
                type="number"
                min="0"
                value={formData.monthlyReviewTarget}
                onChange={e => setFormData(prev => ({ ...prev, monthlyReviewTarget: parseInt(e.target.value) || 0 }))}
                placeholder="e.g. 20"
                data-testid="input-monthly-review-target"
              />
              <p className="text-xs text-muted-foreground mt-1">Reviews/month goal applied to every report's velocity band. A report's own target still overrides this. Leave 0 for no target.</p>
            </div>
            <div>
              <Label className="text-base font-semibold">Lifetime Value Baselines</Label>
              <p className="text-xs text-muted-foreground mb-2">Historical totals before report tracking began</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="initialLeads" className="text-xs">Initial Leads</Label>
                  <Input
                    id="initialLeads"
                    type="number"
                    min="0"
                    value={formData.initialLeads}
                    onChange={e => setFormData(prev => ({ ...prev, initialLeads: parseInt(e.target.value) || 0 }))}
                    data-testid="input-initial-leads"
                  />
                </div>
                <div>
                  <Label htmlFor="initialReviews" className="text-xs">Initial Reviews</Label>
                  <Input
                    id="initialReviews"
                    type="number"
                    min="0"
                    value={formData.initialReviews}
                    onChange={e => setFormData(prev => ({ ...prev, initialReviews: parseInt(e.target.value) || 0 }))}
                    data-testid="input-initial-reviews"
                  />
                </div>
                <div>
                  <Label htmlFor="initialCases" className="text-xs">Initial Cases</Label>
                  <Input
                    id="initialCases"
                    type="number"
                    min="0"
                    value={formData.initialCases}
                    onChange={e => setFormData(prev => ({ ...prev, initialCases: parseInt(e.target.value) || 0 }))}
                    data-testid="input-initial-cases"
                  />
                </div>
              </div>
            </div>
            <div>
              <Label htmlFor="consultType">Consult Type</Label>
              <Select value={formData.consultType} onValueChange={v => setFormData(prev => ({ ...prev, consultType: v }))}>
                <SelectTrigger data-testid="select-consult-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Practice Areas</Label>
              <div className="grid grid-cols-2 gap-2 mt-2 p-3 bg-surface-warm-1 rounded-md max-h-48 overflow-y-auto">
                {PRACTICE_AREA_OPTIONS.map(area => (
                  <label 
                    key={area} 
                    className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/60 p-1 rounded"
                  >
                    <input
                      type="checkbox"
                      checked={formData.practiceAreas.includes(area)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setFormData(prev => ({ ...prev, practiceAreas: [...prev.practiceAreas, area] }));
                        } else {
                          setFormData(prev => ({ ...prev, practiceAreas: prev.practiceAreas.filter(a => a !== area) }));
                        }
                      }}
                      className="w-4 h-4 text-primary border-border rounded focus:ring-primary"
                      data-testid={`checkbox-practice-area-${area.toLowerCase().replace(/\s+/g, '-')}`}
                    />
                    <span>{area}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-base font-semibold">Review Generation Automation</Label>
              <p className="text-xs text-muted-foreground mb-2">Track which automated review sources are enabled</p>
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="edit-hasPostConsultReviewAccess"
                    checked={formData.hasPostConsultReviewAccess}
                    onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hasPostConsultReviewAccess: !!checked }))}
                    data-testid="checkbox-edit-post-consult-review"
                  />
                  <label htmlFor="edit-hasPostConsultReviewAccess" className="text-sm cursor-pointer">
                    Post Consult Automation Enabled?
                  </label>
                </div>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="edit-hasPostCaseClosedReviewAccess"
                    checked={formData.hasPostCaseClosedReviewAccess}
                    onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hasPostCaseClosedReviewAccess: !!checked }))}
                    data-testid="checkbox-edit-post-case-closed-review"
                  />
                  <label htmlFor="edit-hasPostCaseClosedReviewAccess" className="text-sm cursor-pointer">
                    Post Case Closed Automation Enabled?
                  </label>
                </div>
              </div>
            </div>
            {/* Task #2667 — team-only toggle to hide the "Other" lead bucket on
                this client's reports. Applies to all of the client's reports. */}
            <div>
              <Label className="text-base font-semibold">Report Display</Label>
              <p className="text-xs text-muted-foreground mb-2">Controls how this client's public reports render</p>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="edit-hideOtherLeads"
                  checked={formData.hideOtherLeads}
                  onCheckedChange={(checked) => setFormData(prev => ({ ...prev, hideOtherLeads: !!checked }))}
                  data-testid="checkbox-edit-hide-other-leads"
                />
                <label htmlFor="edit-hideOtherLeads" className="text-sm cursor-pointer">
                  Hide "Other" leads on reports
                  <span className="block text-xs text-muted-foreground">
                    Removes social / direct call / referral / residual leads from lead totals, the lead-source breakdown, and all derived figures. Underlying data is still imported and stored.
                  </span>
                </label>
              </div>
            </div>
            {(user.role === "team_lead" || user.role === "ceo") && (
              <div>
                <Label htmlFor="ownerId">Account Manager</Label>
                <Select 
                  value={formData.ownerId || "_unassigned"} 
                  onValueChange={v => setFormData(prev => ({ ...prev, ownerId: v === "_unassigned" ? "" : v }))}
                >
                  <SelectTrigger data-testid="select-owner">
                    <SelectValue placeholder="Select account manager" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_unassigned">Unassigned</SelectItem>
                    {allUsers.map(u => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.firstName ? `${u.firstName}${u.lastName ? ` ${u.lastName}` : ''}` : u.email || u.id}
                        {u.role && ` (${u.role === 'ceo' ? 'CEO' : u.role === 'team_lead' ? 'Team Lead' : 'Account Manager'})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                type="submit" 
                className="bg-primary hover:bg-primary/90"
                disabled={updateMutation.isPending}
                data-testid="button-save-client"
              >
                {updateMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      
      <Dialog open={duplicateDialogOpen} onOpenChange={setDuplicateDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Duplicate Report</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="targetMonth">Target Data Month</Label>
              <Input
                id="targetMonth"
                type="month"
                value={duplicateTargetMonth}
                onChange={e => setDuplicateTargetMonth(e.target.value)}
                data-testid="input-duplicate-target-month"
              />
              <p className="text-xs text-muted-foreground/70 mt-1">The month you're reporting on for the new report</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDuplicateDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (duplicateReportId && duplicateTargetMonth) {
                    duplicateReportMutation.mutate({ 
                      reportId: duplicateReportId, 
                      targetMonth: duplicateTargetMonth 
                    });
                  }
                }}
                disabled={duplicateReportMutation.isPending || !duplicateTargetMonth}
                data-testid="button-confirm-duplicate"
              >
                {duplicateReportMutation.isPending ? "Duplicating..." : "Duplicate"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
