// Task #3626 — Role Assignments management console.
//
// Company-wide internal admin tool for assigning and managing the universal
// Doer/Checker responsibilities across every active department.
// Reads and writes use the neutral /api/admin/role-assignments boundary.
//
// Access mirrors the API: team lead and above (the endpoints 403 otherwise).

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/admin/PageHeader";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { AlertTriangle, Building2, RefreshCw, UserPlus, Users2, Wand2 } from "lucide-react";
import { DepartmentMembersDialog } from "@/components/admin/DepartmentMembersDialog";
import { Link } from "wouter";

// ── Types ────────────────────────────────────────────────────────────────────
import { projectionToastLabel, ProjectionStatusBadge, ProjectionStatusCard, type ProjectionStatusRow, type ProjectionStatusKind, isResyncEligible } from "@/components/ui/ClickUpProjectionStatus";

interface ClientMirrorStatusRow {
  id: string;
  clientId: string;
  status: "pending" | "synced" | "ambiguous" | "blocked" | "drift" | "failed";
  attemptCount: number;
  lastErrorCode: string | null;
  lastError: string | null;
  retryEligible: boolean;
}

interface CanonicalRoleField {
  id: string;
  label: string;
  type: string;
  observedTaskCount: number;
  observedMaxCardinality: number | null;
}

interface CanonicalRoleColumn {
  departmentId: string;
  departmentName: string;
  responsibility: "doer" | "checker";
  expectedLabel: string;
  destination: {
    id: string;
    workspaceId: string;
    peopleFieldId: string;
    peopleFieldLabel: string | null;
    peopleFieldType: string | null;
    maxPeople: number;
    enabled: boolean;
    sandboxExitApprovedAt: string | null;
    ownerApprovedAt: string | null;
  } | null;
  field: CanonicalRoleField | null;
  duplicateLabelFieldIds: string[];
  issues: string[];
  ready: boolean;
}

interface CanonicalRoleColumnPreflight {
  available: boolean;
  canonicalListId: string;
  workspaceId: string | null;
  reason?: string;
  fetchedAt?: number;
  fields?: CanonicalRoleField[];
  roleColumns?: CanonicalRoleColumn[];
  mappings?: Array<{ observedSyncState: "verified" | "conflict" | "stale" }>;
  totals?: { roleColumns: number; mappings: number };
  truncated?: boolean;
}

interface SdDepartment {
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

interface CoverageRow {
  clientId: string;
  firmName: string;
  departmentId: string;
  deptName: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
  defaultPrimaryUserId: string | null;
  defaultCheckerUserId: string | null;
  hasCoverage: boolean;
  stalePrimary: boolean;
  staleChecker: boolean;
  missingDoer: boolean;
  missingChecker: boolean;
  roleStates: AssignmentRoleStates;
}

// Task #4171 — one row per company-scope department: the department-level
// holders ARE the company-wide Doer/Checker.
interface CompanyRow {
  departmentId: string;
  deptName: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
  stalePrimary: boolean;
  staleChecker: boolean;
  missingDoer: boolean;
  missingChecker: boolean;
  roleStates: AssignmentRoleStates;
}

interface ProjectionState {
  externalUserId: string | null;
  ready: boolean;
  workspaceVerification: "verified" | "unverified" | "mismatch" | "not_requested";
}

interface AssignmentRoleState {
  userId: string | null;
  source: "company" | "client_override" | "default" | null;
  eligibility: "eligible" | "ineligible" | "unassigned";
  stale: boolean;
  projection: ProjectionState;
}

interface AssignmentRoleStates {
  doer: AssignmentRoleState;
  checker?: AssignmentRoleState;
}

interface NoBullUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
}

type AssignableRoleKey = "primary" | "checker";

const ROLE_LABELS: Record<AssignableRoleKey, string> = {
  primary: "Doer",
  checker: "Checker",
};

const ASSIGNABLE_ROLE_FIELD: Record<AssignableRoleKey, "primaryUserId" | "checkerUserId"> = {
  primary: "primaryUserId",
  checker: "checkerUserId",
};

const ASSIGNABLE_ROLE_MISSING: Record<AssignableRoleKey, "missingDoer" | "missingChecker"> = {
  primary: "missingDoer",
  checker: "missingChecker",
};

const ASSIGNABLE_RESPONSIBILITY: Record<AssignableRoleKey, "doer" | "checker"> = {
  primary: "doer",
  checker: "checker",
};

type GapFilter = "all" | "any" | AssignableRoleKey;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function RoleAssignments() {
  const coverageQuery = useQuery<{
    rows: CoverageRow[];
    companyRows: CompanyRow[];
    departments: SdDepartment[];
    membersByDept: Record<string, string[]>;
    memberProjectionByDept: Record<string, Record<string, ProjectionState>>;
    projectionConfigured: boolean;
  }>({
    queryKey: ["/api/admin/role-assignments"],
    staleTime: 30_000,
  });

  const usersQuery = useQuery<NoBullUser[]>({
    queryKey: ["/api/users"],
    staleTime: 60_000,
  });

  const users = usersQuery.data ?? [];
  // Stable reference: `?? []` mints a new array every render, which would make
  // every hook that lists `rows` as a dependency (gapCounts below) recompute
  // on each render (lint-react-hooks exhaustive-deps).
  const rows = useMemo(() => coverageQuery.data?.rows ?? [], [coverageQuery.data]);
  const companyRows = useMemo(() => coverageQuery.data?.companyRows ?? [], [coverageQuery.data]);
  const departments = useMemo(() => coverageQuery.data?.departments ?? [], [coverageQuery.data]);
  const membersByDept = useMemo(() => coverageQuery.data?.membersByDept ?? {}, [coverageQuery.data]);
  const memberProjectionByDept = useMemo(
    () => coverageQuery.data?.memberProjectionByDept ?? {},
    [coverageQuery.data],
  );
  const projectionConfigured = coverageQuery.data?.projectionConfigured ?? false;
  // Task #4171 — company-scope departments never appear in per-client
  // surfaces (grid rows already exclude them server-side; bulk targets must
  // too). Members management still covers ALL departments.
  const perClientDepartments = useMemo(
    () => departments.filter((d) => (d.assignmentScope ?? "per_client") !== "company"),
    [departments],
  );
  const checkerCapableDepartmentIds = useMemo(
    () => new Set(departments.filter((department) => department.roleCapabilities?.checker === true).map((department) => department.id)),
    [departments],
  );
  const hasCheckerDepartments = checkerCapableDepartmentIds.size > 0;

  // Task #5156 — ClickUp projection status (problemOnly=true, limit 100).
  // Bounded query; only shows rows needing attention. Refreshed after
  // assignment mutations and explicit resync.
  const projectionStatusQuery = useQuery<{
    statuses: ProjectionStatusRow[];
    environment: string;
  }>({
    queryKey: ["/api/service-desk/role-projections/status", { problemOnly: true, limit: 100 }],
    queryFn: async () => {
      const res = await fetch("/api/service-desk/role-projections/status?problemOnly=true&limit=100");
      if (res.status === 404 || res.status === 503) return { statuses: [], environment: "unconfigured" };
      if (!res.ok) throw new Error("Failed to load projection status");
      return res.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  // The owner-only setup read is deliberately separate from command status.
  // It performs a fresh canonical-list evidence read on each explicit recheck;
  // the server repeats that proof before accepting a mapping or approval.
  const roleColumnSetupQuery = useQuery<CanonicalRoleColumnPreflight>({
    queryKey: ["/api/service-desk/role-projections/client-list/preflight", { limit: 200 }],
    queryFn: async () => {
      const res = await fetch("/api/service-desk/role-projections/client-list/preflight?limit=200");
      if (!res.ok) throw new Error(res.status === 403
        ? "Only the company owner can review ClickUp role-column setup."
        : "ClickUp role-column setup could not be checked.");
      return res.json();
    },
    staleTime: 0,
    retry: false,
  });

  // Task #5245 — durable parent-task lifecycle mirror. Unlike role projection,
  // this view includes synced rows as well as recovery states so operators can
  // distinguish a healthy canonical client parent from one awaiting review.
  const clientMirrorStatusQuery = useQuery<{ statuses: ClientMirrorStatusRow[] }>({
    queryKey: ["/api/service-desk/client-mirror/status", { limit: 100 }],
    queryFn: async () => {
      const res = await fetch("/api/service-desk/client-mirror/status?limit=100");
      if (!res.ok) throw new Error("Failed to load client mirror status");
      return res.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const [bulkOpen, setBulkOpen] = useState(false);
  // Task #4002 — controlled tabs + membership management. "No active members"
  // dead-ends route here: jump to the Members tab and open that department's
  // membership editor so operators can fix membership without leaving the
  // console. Membership changes invalidate the coverage query, so role
  // pickers reflect new members immediately.
  const [tab, setTab] = useState("grid");
  const [membersDeptId, setMembersDeptId] = useState<string | null>(null);
  const membersDept = departments.find((d) => d.id === membersDeptId) ?? null;

  function openMembersFor(departmentId: string) {
    setBulkOpen(false);
    setTab("members");
    setMembersDeptId(departmentId);
  }

  function userName(userId: string | null | undefined): string {
    if (!userId) return "—";
    const u = users.find((x) => x.id === userId);
    if (!u) return userId;
    return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || userId;
  }

  const gapCounts = useMemo(
    () => ({
      primary: rows.filter((r) => r.missingDoer).length + companyRows.filter((r) => r.missingDoer).length,
      checker:
        rows.filter((r) => checkerCapableDepartmentIds.has(r.departmentId) && r.missingChecker).length +
        companyRows.filter((r) => checkerCapableDepartmentIds.has(r.departmentId) && r.missingChecker).length,
    }),
    [rows, companyRows, checkerCapableDepartmentIds],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6" data-testid="role-assignments-page">
      {/* Task #4661 — shared Pattern-A header (was a hand-rolled block with an
          icon-only, unlabeled back button and text-primary heading ink). */}
      <PageHeader
        title="Role Assignments"
        subtitle="The company-wide source of truth for department roles, defaults, client overrides, and member eligibility."
        backHref="/"
        backLabel="Home"
        backTestId="button-back-home"
        actions={
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="secondary"
            className={gapCounts.primary > 0 ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" : "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800"}
            data-testid="badge-gap-doer"
          >
            {gapCounts.primary} missing Doer
          </Badge>
          {hasCheckerDepartments && <Badge
            variant="secondary"
            className={gapCounts.checker > 0 ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800" : "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800"}
            data-testid="badge-gap-checker"
          >
            {gapCounts.checker} missing Checker
          </Badge>}
          <Button size="sm" onClick={() => setBulkOpen(true)} data-testid="button-open-bulk-assign">
            <Wand2 className="h-3.5 w-3.5 mr-1.5" />
            Bulk assign
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => coverageQuery.refetch()}
            aria-label="Refresh coverage grid"
            data-testid="button-refresh-grid"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        }
      />

      <section
        className={`grid gap-3 border bg-card p-4 ${hasCheckerDepartments ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}
        aria-label="Universal responsibility meanings"
        data-testid="role-responsibility-meanings"
      >
        <div>
          <h2 className="text-sm font-semibold">Doer</h2>
          <p className="text-xs text-muted-foreground">Owns and completes the work.</p>
          <p className="text-caption text-muted-foreground mt-1">Service Desk clarifier: ClickUp owner</p>
        </div>
        {hasCheckerDepartments && (
          <div>
            <h2 className="text-sm font-semibold">Checker</h2>
            <p className="text-xs text-muted-foreground">Reviews the work for quality and completion.</p>
            <p className="text-caption text-muted-foreground mt-1">Service Desk clarifier: watcher</p>
          </div>
        )}
      </section>

      {/* Task #5156 — Compact ClickUp projection problems panel */}
      <RoleColumnSetupSection query={roleColumnSetupQuery} />
      <ProjectionStatusSection
        query={projectionStatusQuery}
        departments={departments}
        onRefresh={() => {
          void coverageQuery.refetch();
          void projectionStatusQuery.refetch();
        }}
      />
      <ClientMirrorStatusSection
        query={clientMirrorStatusQuery}
        clientNames={new Map(rows.map((row) => [row.clientId, row.firmName]))}
      />

      {coverageQuery.isLoading ? (
        <div className="p-8 text-sm text-muted-foreground">Loading role assignments…</div>
      ) : coverageQuery.isError ? (
        <div className="p-8 text-sm text-destructive">Failed to load role assignments.</div>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex flex-wrap h-auto w-fit max-w-full">
            <TabsTrigger value="grid" data-testid="tab-by-client">
              By client / department
            </TabsTrigger>
            <TabsTrigger value="person" data-testid="tab-by-person">
              <Users2 className="h-3.5 w-3.5 mr-1.5" />
              By person
            </TabsTrigger>
            <TabsTrigger value="company" data-testid="tab-company-defaults">
              <Building2 className="h-3.5 w-3.5 mr-1.5" />
              Company & defaults
            </TabsTrigger>
            <TabsTrigger value="members" data-testid="tab-members">
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              Members
            </TabsTrigger>
          </TabsList>
          <TabsContent value="grid" className="mt-4">
            <GridView
              rows={rows}
              users={users}
              membersByDept={membersByDept}
              userName={userName}
              onManageMembers={openMembersFor}
              projectionConfigured={projectionConfigured}
              checkerCapableDepartmentIds={checkerCapableDepartmentIds}
            />
          </TabsContent>
          <TabsContent value="person" className="mt-4">
            <ByPersonView
              rows={rows}
              companyRows={companyRows}
              users={users}
              userName={userName}
              departments={departments}
              membersByDept={membersByDept}
            />
          </TabsContent>
          <TabsContent value="company" className="mt-4">
            <CompanyDefaultsView
              companyRows={companyRows}
              departments={departments}
              users={users}
              membersByDept={membersByDept}
              userName={userName}
              onManageMembers={openMembersFor}
              projectionConfigured={projectionConfigured}
            />
          </TabsContent>
          <TabsContent value="members" className="mt-4">
            <MembersView
              departments={departments}
              membersByDept={membersByDept}
              memberProjectionByDept={memberProjectionByDept}
              projectionConfigured={projectionConfigured}
              userName={userName}
              onManage={(departmentId) => setMembersDeptId(departmentId)}
            />
          </TabsContent>
        </Tabs>
      )}

      <BulkAssignDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        rows={rows}
        departments={perClientDepartments}
        users={users}
        membersByDept={membersByDept}
        userName={userName}
        onManageMembers={openMembersFor}
      />

      <DepartmentMembersDialog
        department={membersDept}
        apiScope="universal"
        onOpenChange={(open) => {
          if (!open) setMembersDeptId(null);
        }}
      />
    </div>
  );
}

function ClientMirrorStatusSection({
  query,
  clientNames,
}: {
  query: {
    data?: { statuses: ClientMirrorStatusRow[] } | null;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
  };
  clientNames: Map<string, string>;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState<string | null>(null);
  const statuses = query.data?.statuses ?? [];

  async function retry(row: ClientMirrorStatusRow) {
    setRetrying(row.id);
    try {
      const response = await apiRequest("POST", `/api/service-desk/client-mirror/${row.id}/retry`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as any).error ?? "Retry was not accepted");
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/client-mirror/status"] });
      toast({ title: "Client mirror retry queued", description: "NoBull client data remains unchanged." });
    } catch (error: any) {
      toast({ title: "Client mirror retry not queued", description: error?.message ?? String(error) });
    } finally {
      setRetrying(null);
    }
  }

  if (!query.isLoading && !query.isError && statuses.length === 0) return null;

  return (
    <section className="border bg-card" data-testid="client-mirror-status-section">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">ClickUp Client Mirror</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Canonical parent-task state. NoBull remains the source of truth.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => query.refetch()}
          aria-label="Refresh client mirror status"
          data-testid="button-refresh-client-mirror-status"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${query.isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {query.isLoading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Checking client mirror status…</div>
      ) : query.isError ? (
        <div className="px-4 py-3 text-xs text-destructive" role="alert">
          {query.error?.message ?? "Client mirror status could not be loaded. Refresh and try again."}
        </div>
      ) : (
        <div className="divide-y">
          {statuses.map((row) => (
            <div
              key={row.id}
              className="flex items-start justify-between gap-3 px-4 py-2.5 text-xs"
              data-testid={`client-mirror-status-row-${row.id}`}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <ProjectionStatusBadge kind={row.status} />
                  <span className="text-muted-foreground">
                    {clientNames.get(row.clientId) ?? row.clientId}
                  </span>
                </div>
                {row.lastError && (
                  <div className="max-w-lg truncate text-red-600 dark:text-red-400" title={row.lastError}>
                    {row.lastError}
                  </div>
                )}
                <div className="text-muted-foreground">
                  {row.lastErrorCode ? `Error code: ${row.lastErrorCode} · ` : ""}
                  {row.attemptCount} attempt{row.attemptCount === 1 ? "" : "s"}
                </div>
              </div>
              {row.retryEligible && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={retrying === row.id}
                  onClick={() => retry(row)}
                  data-testid={`button-retry-client-mirror-${row.id}`}
                >
                  <RefreshCw className={`mr-1 h-3 w-3 ${retrying === row.id ? "animate-spin" : ""}`} />
                  {retrying === row.id ? "Retrying…" : "Retry"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Grid view (by client × department) ───────────────────────────────────────

function StaleWarning() {
  return (
    <span
      className="inline-flex items-center text-amber-600 ml-1"
      title="This user is no longer an active member of the department"
      data-testid="icon-stale-member"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

function AssignmentStateBadges({
  state,
  projectionConfigured,
}: {
  state: AssignmentRoleState;
  projectionConfigured: boolean;
}) {
  if (!state.userId) return null;
  const sourceLabel =
    state.source === "client_override"
      ? "Explicit"
      : state.source === "default"
        ? "Inherited"
        : state.source === "company"
          ? "Company-wide"
          : null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="assignment-state-badges">
      {sourceLabel && (
        <Badge variant="outline" className="text-caption px-1.5 py-0 font-normal">
          {sourceLabel}
        </Badge>
      )}
      {state.stale && (
        <Badge variant="secondary" className="text-caption px-1.5 py-0 bg-amber-50 text-amber-700 border-amber-200">
          Stale membership
        </Badge>
      )}
      {!projectionConfigured ? (
        <Badge
          variant="outline"
          className="text-caption px-1.5 py-0 font-normal"
          title="ClickUp projection is not configured for this company; this assignment remains active in NoBull."
          data-testid="badge-projection-nobull-only"
        >
          NoBull only
        </Badge>
      ) : state.projection.ready ? (
        <Badge
          variant="outline"
          className="text-caption px-1.5 py-0 font-normal text-green-700 border-green-200"
          data-testid="badge-projection-ready"
        >
          ClickUp ready
        </Badge>
      ) : (
        <Badge
          variant="secondary"
          className="text-caption px-1.5 py-0 bg-amber-50 text-amber-700 border-amber-200"
          title="This eligible role holder has no verified ClickUp identity for the configured workspace."
          data-testid="badge-projection-missing-identity"
        >
          Missing ClickUp identity
        </Badge>
      )}
    </div>
  );
}

function RoleAssignmentCell({
  state,
  userName,
  projectionConfigured,
}: {
  state: AssignmentRoleState;
  userName: (id: string | null | undefined) => string;
  projectionConfigured: boolean;
}) {
  if (!state.userId) {
    return (
      <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800 text-xs">
        Gap
      </Badge>
    );
  }
  return (
    <div className="min-w-36">
      <span>
        {userName(state.userId)}
        {state.stale && <StaleWarning />}
      </span>
      <AssignmentStateBadges state={state} projectionConfigured={projectionConfigured} />
    </div>
  );
}

function GridView({
  rows,
  users,
  membersByDept,
  userName,
  onManageMembers,
  projectionConfigured,
  checkerCapableDepartmentIds,
}: {
  rows: CoverageRow[];
  users: NoBullUser[];
  membersByDept: Record<string, string[]>;
  userName: (id: string | null | undefined) => string;
  onManageMembers: (departmentId: string) => void;
  projectionConfigured: boolean;
  checkerCapableDepartmentIds: Set<string>;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [gapFilter, setGapFilter] = useState<GapFilter>("all");
  const [editRow, setEditRow] = useState<{ clientId: string; departmentId: string } | null>(null);
  const [primaryUserId, setPrimaryUserId] = useState("");
  const [checkerUserId, setCheckerUserId] = useState("");
  const [saving, setSaving] = useState(false);

  const filteredRows = rows
    .filter((r) => {
      if (gapFilter === "all") return true;
      if (gapFilter === "any") {
        return r.missingDoer || (checkerCapableDepartmentIds.has(r.departmentId) && r.missingChecker);
      }
      if (gapFilter === "checker" && !checkerCapableDepartmentIds.has(r.departmentId)) return false;
      return r[ASSIGNABLE_ROLE_MISSING[gapFilter]];
    })
    .filter(
      (r) =>
        !searchQuery ||
        r.firmName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        r.deptName.toLowerCase().includes(searchQuery.toLowerCase()),
    );

  function startEdit(row: CoverageRow) {
    setPrimaryUserId(row.primaryUserId ?? "");
    setCheckerUserId(row.checkerUserId ?? "");
    setEditRow({ clientId: row.clientId, departmentId: row.departmentId });
  }

  function cancelEdit() {
    setEditRow(null);
    setPrimaryUserId("");
    setCheckerUserId("");
  }

  async function saveEdit() {
    if (!editRow) return;
    setSaving(true);
    try {
      const res = await apiRequest(
        "PUT",
        `/api/admin/role-assignments/clients/${editRow.clientId}/departments/${editRow.departmentId}`,
        {
          primaryUserId: primaryUserId || null,
          ...(checkerCapableDepartmentIds.has(editRow.departmentId) ? { checkerUserId: checkerUserId || null } : {}),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Save failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/role-assignments"] });
      // Task #5156 — also refresh projection status panel after assignment change
      // (matches the default-departments and bulk-assignment save paths below).
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/role-projections/status"] });
      toast({ title: "Assignment saved" });
      cancelEdit();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="role-assignments-grid">
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search client or department…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-sm"
          data-testid="input-search-grid"
        />
        <Select value={gapFilter} onValueChange={(v) => setGapFilter(v as GapFilter)}>
          <SelectTrigger className="h-9 text-sm w-52" data-testid="select-gap-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rows</SelectItem>
            <SelectItem value="any">Any gap</SelectItem>
            <SelectItem value="primary">Missing Doer</SelectItem>
            {checkerCapableDepartmentIds.size > 0 && <SelectItem value="checker">Missing Checker</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Client</TableHead>
              <TableHead className="whitespace-nowrap">Department</TableHead>
              <TableHead className="whitespace-nowrap">Doer</TableHead>
              {checkerCapableDepartmentIds.size > 0 && <TableHead className="whitespace-nowrap">Checker</TableHead>}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4 + (checkerCapableDepartmentIds.size > 0 ? 1 : 0)} className="text-center text-sm text-muted-foreground py-8">
                  No rows match the current filters.
                </TableCell>
              </TableRow>
            )}
            {filteredRows.map((row) => {
              const isEditing = editRow?.clientId === row.clientId && editRow?.departmentId === row.departmentId;
              const deptMemberIds = membersByDept[row.departmentId] ?? [];
              const deptUsers = users.filter((u) => deptMemberIds.includes(u.id));
              const checkerCapable = checkerCapableDepartmentIds.has(row.departmentId);
              return (
                <TableRow key={`${row.clientId}|${row.departmentId}`} data-testid={`grid-row-${row.clientId}-${row.departmentId}`}>
                  <TableCell className="text-sm font-medium">{row.firmName}</TableCell>
                  <TableCell className="text-sm">{row.deptName}</TableCell>
                  {isEditing ? (
                    <>
                      {([
                          [primaryUserId, setPrimaryUserId, "primary"],
                          ...(checkerCapableDepartmentIds.size > 0
                            ? [[checkerUserId, checkerCapable ? setCheckerUserId : null, "checker"]]
                            : []),
                        ] as Array<[string, React.Dispatch<React.SetStateAction<string>> | null, AssignableRoleKey]>).map(([value, setter, role]) => (
                        setter === null ? (
                          <TableCell key={role} className="text-sm text-muted-foreground" data-testid={`checker-unavailable-grid-${row.departmentId}`}>
                            Not available
                          </TableCell>
                        ) : <TableCell key={role}>
                          <Select
                            value={value || SELECT_NONE_VALUE}
                            onValueChange={(v) => setter(v === SELECT_NONE_VALUE ? "" : v)}
                          >
                            <SelectTrigger className="h-8 text-xs w-40" data-testid={`select-${role}-grid`}>
                              <SelectValue placeholder="None (dept default)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={SELECT_NONE_VALUE}>None (dept default)</SelectItem>
                              {deptUsers.map((u) => (
                                <SelectItem key={u.id} value={u.id}>
                                  {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {role === "primary" && deptUsers.length === 0 && (
                            <button
                              type="button"
                              className="mt-1 block text-[11px] text-amber-600 underline underline-offset-2"
                              onClick={() => onManageMembers(row.departmentId)}
                              data-testid={`button-grid-manage-members-${row.departmentId}`}
                            >
                              No active members — manage
                            </button>
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" onClick={saveEdit} disabled={saving} data-testid="button-save-grid">
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving} data-testid="button-cancel-grid">
                            Cancel
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      {(["doer", ...(checkerCapableDepartmentIds.size > 0 ? ["checker" as const] : [])] as Array<"doer" | "checker">).map((responsibility) =>
                        responsibility === "checker" && !checkerCapable ? (
                          <TableCell key={responsibility} className="text-sm text-muted-foreground align-top" data-testid={`checker-unavailable-grid-${row.departmentId}`}>
                            Not available
                          </TableCell>
                        ) : (
                          <TableCell key={responsibility} className="text-sm align-top">
                            <RoleAssignmentCell
                              state={row.roleStates[responsibility]!}
                              userName={userName}
                              projectionConfigured={projectionConfigured}
                            />
                          </TableCell>
                        ),
                      )}
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(row)}
                          data-testid={`button-edit-grid-${row.clientId}-${row.departmentId}`}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── Members view (department membership management, Task #4002) ──────────────

function MembersView({
  departments,
  membersByDept,
  memberProjectionByDept,
  projectionConfigured,
  userName,
  onManage,
}: {
  departments: SdDepartment[];
  membersByDept: Record<string, string[]>;
  memberProjectionByDept: Record<string, Record<string, ProjectionState>>;
  projectionConfigured: boolean;
  userName: (id: string | null | undefined) => string;
  onManage: (departmentId: string) => void;
}) {
  return (
    <div className="rounded-lg border bg-card overflow-x-auto" data-testid="role-assignments-members">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="whitespace-nowrap">Department</TableHead>
            <TableHead className="whitespace-nowrap">Members</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {departments.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-center text-sm text-muted-foreground py-8">
                No active departments.
              </TableCell>
            </TableRow>
          )}
          {departments.map((d) => {
            const memberIds = membersByDept[d.id] ?? [];
            return (
              <TableRow key={d.id} data-testid={`members-row-${d.id}`}>
                <TableCell className="text-sm font-medium whitespace-nowrap">{d.name}</TableCell>
                <TableCell>
                  {memberIds.length === 0 ? (
                    <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800 text-xs">
                      No active members
                    </Badge>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {memberIds.map((id) => {
                        const projection = memberProjectionByDept[d.id]?.[id];
                        const label = !projectionConfigured
                          ? "NoBull only — ClickUp projection is not configured"
                          : projection?.ready
                            ? "ClickUp ready"
                            : "Missing ClickUp identity";
                        return (
                          <span key={id} className="inline-flex items-center gap-1">
                            <Badge variant="secondary" className="text-xs font-normal">
                              {userName(id)}
                            </Badge>
                            <span
                              className={projectionConfigured && !projection?.ready ? "text-caption text-amber-700" : "text-caption text-muted-foreground"}
                              title={label}
                              data-testid={`member-projection-${d.id}-${id}`}
                            >
                              {projectionConfigured ? (projection?.ready ? "ClickUp ready" : "Missing ClickUp identity") : "NoBull only"}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onManage(d.id)}
                    data-testid={`button-manage-members-${d.id}`}
                  >
                    <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                    Manage
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Company roles & per-department defaults (Task #4171) ────────────────────

function CompanyDefaultsView({
  companyRows,
  departments,
  users,
  membersByDept,
  userName,
  onManageMembers,
  projectionConfigured,
}: {
  companyRows: CompanyRow[];
  departments: SdDepartment[];
  users: NoBullUser[];
  membersByDept: Record<string, string[]>;
  userName: (id: string | null | undefined) => string;
  onManageMembers: (departmentId: string) => void;
  projectionConfigured: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editDeptId, setEditDeptId] = useState<string | null>(null);
  const [primaryUserId, setPrimaryUserId] = useState("");
  const [checkerUserId, setCheckerUserId] = useState("");
  const [saving, setSaving] = useState(false);

  const perClientDepts = departments.filter((d) => (d.assignmentScope ?? "per_client") !== "company");
  const checkerCapable = (departmentId: string) =>
    departments.find((department) => department.id === departmentId)?.roleCapabilities?.checker === true;
  const hasCheckerDepartments = departments.some((department) => department.roleCapabilities?.checker === true);

  function startEdit(
    deptId: string,
    primary: string | null | undefined,
    checker: string | null | undefined,
  ) {
    setEditDeptId(deptId);
    setPrimaryUserId(primary ?? "");
    setCheckerUserId(checker ?? "");
  }

  function cancelEdit() {
    setEditDeptId(null);
    setPrimaryUserId("");
    setCheckerUserId("");
  }

  async function saveEdit() {
    if (!editDeptId) return;
    setSaving(true);
    try {
      const res = await apiRequest("PUT", `/api/admin/role-assignments/departments/${editDeptId}`, {
        defaultPrimaryUserId: primaryUserId || null,
        ...(checkerCapable(editDeptId) ? { defaultCheckerUserId: checkerUserId || null } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Save failed");
      }
      const body = await res.json().catch(() => ({}));
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/role-assignments"] });
      // Task #5156 — also refresh projection status panel after defaults change.
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/role-projections/status"] });
      const projLabel = projectionToastLabel((body as any)?.projection);
      toast({ title: "Role holders saved", description: projLabel ?? undefined });
      cancelEdit();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // Shared editing cells for both tables.
  const editCells = (deptId: string) => {
    const deptMemberIds = membersByDept[deptId] ?? [];
    const deptUsers = users.filter((u) => deptMemberIds.includes(u.id));
    return (
      <>
        {([
            [primaryUserId, setPrimaryUserId, "primary"],
            ...(hasCheckerDepartments
              ? [[checkerUserId, checkerCapable(deptId) ? setCheckerUserId : null, "checker"]]
              : []),
          ] as Array<[string, React.Dispatch<React.SetStateAction<string>> | null, AssignableRoleKey]>).map(([value, setter, role]) => (
          setter === null ? (
            <TableCell key={role} className="text-sm text-muted-foreground" data-testid={`checker-unavailable-defaults-${deptId}`}>
              Not available
            </TableCell>
          ) : <TableCell key={role}>
            <Select value={value || SELECT_NONE_VALUE} onValueChange={(v) => setter(v === SELECT_NONE_VALUE ? "" : v)}>
              <SelectTrigger className="h-8 text-xs w-40" data-testid={`select-${role}-defaults`}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE_VALUE}>None</SelectItem>
                {deptUsers.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {role === "primary" && deptUsers.length === 0 && (
              <button
                type="button"
                className="mt-1 block text-[11px] text-amber-600 underline underline-offset-2"
                onClick={() => onManageMembers(deptId)}
                data-testid={`button-defaults-manage-members-${deptId}`}
              >
                No active members — manage
              </button>
            )}
          </TableCell>
        ))}
        <TableCell className="text-right">
          <div className="flex gap-1 justify-end">
            <Button size="sm" onClick={saveEdit} disabled={saving} data-testid="button-save-defaults">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving} data-testid="button-cancel-defaults">
              Cancel
            </Button>
          </div>
        </TableCell>
      </>
    );
  };

  return (
    <div className="space-y-6" data-testid="role-assignments-company-defaults">
      <div className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Company-wide roles</h2>
          <p className="text-xs text-muted-foreground">
            These departments hold one Doer and, where supported, one Checker for the whole company — they never appear
            on per-client surfaces.
          </p>
        </div>
        {companyRows.length === 0 ? (
          <div
            className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground"
            data-testid="company-roles-empty"
          >
            No company-scope departments yet. Mark a department as company-wide in Service Desk Settings to manage its
            roles here.
          </div>
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Department</TableHead>
                  <TableHead className="whitespace-nowrap">Doer</TableHead>
              {hasCheckerDepartments && <TableHead className="whitespace-nowrap">Checker</TableHead>}
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {companyRows.map((row) => {
                  const isEditing = editDeptId === row.departmentId;
                  return (
                    <TableRow key={row.departmentId} data-testid={`company-row-${row.departmentId}`}>
                      <TableCell className="text-sm font-medium whitespace-nowrap">{row.deptName}</TableCell>
                      {isEditing ? (
                        editCells(row.departmentId)
                      ) : (
                        <>
                          {(["doer", ...(hasCheckerDepartments ? ["checker" as const] : [])] as Array<"doer" | "checker">).map((responsibility) =>
                            responsibility === "checker" && !checkerCapable(row.departmentId) ? (
                              <TableCell key={responsibility} className="text-sm text-muted-foreground align-top" data-testid={`checker-unavailable-company-${row.departmentId}`}>
                                Not available
                              </TableCell>
                            ) : (
                              <TableCell key={responsibility} className="text-sm align-top">
                                <RoleAssignmentCell
                                  state={row.roleStates[responsibility]!}
                                  userName={userName}
                                  projectionConfigured={projectionConfigured}
                                />
                              </TableCell>
                            ),
                          )}
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => startEdit(row.departmentId, row.primaryUserId, row.checkerUserId)}
                              data-testid={`button-edit-company-${row.departmentId}`}
                            >
                              Edit
                            </Button>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div>
          <h2 className="text-sm font-semibold">Per-department defaults</h2>
          <p className="text-xs text-muted-foreground">
            Defaults pre-fill the Add Client form and cover any client without an explicit person for a role. Changing
            a default never rewrites existing explicit assignments.
          </p>
        </div>
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Department</TableHead>
                <TableHead className="whitespace-nowrap">Default Doer</TableHead>
                {hasCheckerDepartments && <TableHead className="whitespace-nowrap">Default Checker</TableHead>}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {perClientDepts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3 + (hasCheckerDepartments ? 1 : 0)} className="text-center text-sm text-muted-foreground py-8">
                    No client-facing departments.
                  </TableCell>
                </TableRow>
              )}
              {perClientDepts.map((d) => {
                const isEditing = editDeptId === d.id;
                const activeMembers = new Set(membersByDept[d.id] ?? []);
                return (
                  <TableRow key={d.id} data-testid={`defaults-row-${d.id}`}>
                    <TableCell className="text-sm font-medium whitespace-nowrap">{d.name}</TableCell>
                    {isEditing ? (
                      editCells(d.id)
                    ) : (
                      <>
                        {([
                          ["primary", d.defaultPrimaryUserId],
                          ...(hasCheckerDepartments ? [["checker", d.defaultCheckerUserId] as const] : []),
                        ] as const).map(([role, userId]) =>
                          role === "checker" && d.roleCapabilities?.checker !== true ? (
                            <TableCell key={role} className="text-sm text-muted-foreground" data-testid={`checker-unavailable-defaults-${d.id}`}>
                              Not available
                            </TableCell>
                          ) : (
                            <TableCell key={role} className="text-sm">
                              {userId ? (
                                <span>
                                  {userName(userId)}
                                  {!activeMembers.has(userId) && <StaleWarning />}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          ),
                        )}
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEdit(d.id, d.defaultPrimaryUserId, d.defaultCheckerUserId)}
                            data-testid={`button-edit-defaults-${d.id}`}
                          >
                            Edit
                          </Button>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}

// ── By-person view ───────────────────────────────────────────────────────────

function ByPersonView({
  rows,
  companyRows,
  users,
  userName,
  departments,
  membersByDept,
}: {
  rows: CoverageRow[];
  companyRows: CompanyRow[];
  users: NoBullUser[];
  userName: (id: string | null | undefined) => string;
  departments: SdDepartment[];
  membersByDept: Record<string, string[]>;
}) {
  const [personSearch, setPersonSearch] = useState("");

  const byPerson = useMemo(() => {
    const map = new Map<
      string,
      {
        userId: string;
        entries: { role: AssignableRoleKey; label: string; deptName: string; stale: boolean; kind: "client" | "company" | "default" }[];
        memberOf: string[];
      }
    >();
    const ensure = (userId: string) => {
      let entry = map.get(userId);
      if (!entry) {
        entry = { userId, entries: [], memberOf: [] };
        map.set(userId, entry);
      }
      return entry;
    };
    for (const row of rows) {
      const slots: [AssignableRoleKey, string | null, boolean][] = [
        ["primary", row.primaryUserId, row.stalePrimary],
        ...(departments.find((department) => department.id === row.departmentId)?.roleCapabilities?.checker === true
          ? [["checker", row.checkerUserId, row.staleChecker] as [AssignableRoleKey, string | null, boolean]]
          : []),
      ];
      for (const [role, userId, stale] of slots) {
        if (!userId) continue;
        ensure(userId).entries.push({ role, label: row.firmName, deptName: row.deptName, stale, kind: "client" });
      }
    }
    // Task #4171 — company-wide role holders and per-department defaults are
    // real holdings too: they resolve tickets, so the by-person
    // view must show them.
    for (const row of companyRows) {
      const slots: [AssignableRoleKey, string | null, boolean][] = [
        ["primary", row.primaryUserId, row.stalePrimary],
        ...(departments.find((department) => department.id === row.departmentId)?.roleCapabilities?.checker === true
          ? [["checker", row.checkerUserId, row.staleChecker] as [AssignableRoleKey, string | null, boolean]]
          : []),
      ];
      for (const [role, userId, stale] of slots) {
        if (!userId) continue;
        ensure(userId).entries.push({ role, label: "Company-wide", deptName: row.deptName, stale, kind: "company" });
      }
    }
    for (const d of departments) {
      if ((d.assignmentScope ?? "per_client") === "company") continue;
      const activeMembers = new Set(membersByDept[d.id] ?? []);
      const slots: [AssignableRoleKey, string | null | undefined][] = [
        ["primary", d.defaultPrimaryUserId],
        ...(d.roleCapabilities?.checker === true
          ? [["checker", d.defaultCheckerUserId] as [AssignableRoleKey, string | null | undefined]]
          : []),
      ];
      for (const [role, userId] of slots) {
        if (!userId) continue;
        ensure(userId).entries.push({ role, label: "Dept default", deptName: d.name, stale: !activeMembers.has(userId), kind: "default" });
      }
    }
    // Task #4002 — department membership alongside roles, including people who
    // are members but hold no role assignments yet.
    const deptNameById = new Map(departments.map((d) => [d.id, d.name]));
    for (const [deptId, userIds] of Object.entries(membersByDept)) {
      const deptName = deptNameById.get(deptId);
      if (!deptName) continue;
      for (const uid of userIds) ensure(uid).memberOf.push(deptName);
    }
    for (const entry of map.values()) entry.memberOf.sort((a, b) => a.localeCompare(b));
    return Array.from(map.values()).sort((a, b) => b.entries.length - a.entries.length);
  }, [rows, companyRows, departments, membersByDept]);

  const filtered = byPerson.filter(
    (p) => !personSearch || userName(p.userId).toLowerCase().includes(personSearch.toLowerCase()),
  );

  return (
    <div className="space-y-3" data-testid="role-assignments-by-person">
      <Input
        placeholder="Search person…"
        value={personSearch}
        onChange={(e) => setPersonSearch(e.target.value)}
        className="max-w-sm"
        data-testid="input-search-person"
      />
      {filtered.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No people hold role assignments or department memberships{personSearch ? " matching the search" : ""}.
        </div>
      )}
      {filtered.map((p) => {
        const roleCounts = {
          primary: p.entries.filter((e) => e.role === "primary").length,
          checker: p.entries.filter((e) => e.role === "checker").length,
        };
        return (
          <div key={p.userId} className="rounded-lg border bg-card p-4 space-y-2" data-testid={`person-card-${p.userId}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="font-medium text-sm">{userName(p.userId)}</div>
              <div className="flex gap-2">
                {(["primary", "checker"] as AssignableRoleKey[]).map(
                  (role) =>
                    roleCounts[role] > 0 && (
                      <Badge key={role} variant="secondary" className="text-xs">
                        {ROLE_LABELS[role]} × {roleCounts[role]}
                      </Badge>
                    ),
                )}
              </div>
            </div>
            <div
              className="flex items-center gap-1.5 flex-wrap text-xs"
              data-testid={`person-memberships-${p.userId}`}
            >
              <span className="text-muted-foreground">Member of:</span>
              {p.memberOf.length === 0 ? (
                <span className="text-amber-600">no departments</span>
              ) : (
                p.memberOf.map((deptName) => (
                  <Badge key={deptName} variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
                    {deptName}
                  </Badge>
                ))
              )}
            </div>
            <div className="text-xs text-muted-foreground grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {p.entries
                .slice()
                .sort((a, b) => a.label.localeCompare(b.label) || a.deptName.localeCompare(b.deptName))
                .map((e, i) => (
                  <div key={i} className="flex items-center gap-1">
                    {e.kind === "client" ? (
                      <span className="font-medium text-foreground">{e.label}</span>
                    ) : (
                      <span className="italic">{e.label}</span>
                    )}
                    <span>· {e.deptName}</span>
                    <Badge variant="outline" className="text-[10px] px-1 py-0">
                      {ROLE_LABELS[e.role]}
                    </Badge>
                    {e.stale && <StaleWarning />}
                  </div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Bulk assignment flow ─────────────────────────────────────────────────────

function BulkAssignDialog({
  open,
  onOpenChange,
  rows,
  departments,
  users,
  membersByDept,
  userName,
  onManageMembers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: CoverageRow[];
  departments: SdDepartment[];
  users: NoBullUser[];
  membersByDept: Record<string, string[]>;
  userName: (id: string | null | undefined) => string;
  onManageMembers: (departmentId: string) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [departmentId, setDepartmentId] = useState("");
  const [role, setRole] = useState<AssignableRoleKey>("primary");
  const [userId, setUserId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clientSearch, setClientSearch] = useState("");
  const [step, setStep] = useState<"pick" | "preview">("pick");
  const [applying, setApplying] = useState(false);

  const deptRows = useMemo(() => rows.filter((r) => r.departmentId === departmentId), [rows, departmentId]);
  const selectedDepartment = departments.find((department) => department.id === departmentId);
  const selectedDepartmentSupportsChecker = selectedDepartment?.roleCapabilities?.checker === true;
  const deptMemberIds = membersByDept[departmentId] ?? [];
  const deptUsers = users.filter((u) => deptMemberIds.includes(u.id));

  const visibleClients = deptRows.filter(
    (r) => !clientSearch || r.firmName.toLowerCase().includes(clientSearch.toLowerCase()),
  );

  function reset() {
    setDepartmentId("");
    setRole("primary");
    setUserId("");
    setSelected(new Set());
    setClientSearch("");
    setStep("pick");
  }

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) reset();
  }

  function toggle(clientId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(deptRows.map((r) => r.clientId)));
  }

  function selectGapsOnly() {
    setSelected(new Set(deptRows.filter((r) => r[ASSIGNABLE_ROLE_MISSING[role]]).map((r) => r.clientId)));
  }

  const preview = useMemo(() => {
    if (!departmentId) return [];
    const field = ASSIGNABLE_ROLE_FIELD[role];
    return deptRows
      .filter((r) => selected.has(r.clientId))
      .map((r) => {
        const current = r[field];
        return {
          clientId: r.clientId,
          firmName: r.firmName,
          currentUserId: current,
          overwrite: current !== null && current !== (userId || null),
          unchanged: current === (userId || null),
        };
      });
  }, [deptRows, selected, role, userId, departmentId]);

  const overwriteCount = preview.filter((p) => p.overwrite).length;

  async function apply() {
    setApplying(true);
    try {
      const res = await apiRequest("POST", "/api/admin/role-assignments/bulk", {
        departmentId,
        responsibility: ASSIGNABLE_RESPONSIBILITY[role],
        userId: userId || null,
        clientIds: preview.map((p) => p.clientId),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as any)?.error ?? "Bulk assignment failed");
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/role-assignments"] });
      // Task #5156 — also refresh projection status panel after bulk assignment.
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/role-projections/status"] });
      const projLabel = projectionToastLabel((body as any)?.projection);
      const count = (body as any)?.updated ?? preview.length;
      toast({
        title: "Bulk assignment applied",
        description: `${count} client${count !== 1 ? "s" : ""} updated (${ROLE_LABELS[role]} → ${userId ? userName(userId) : "cleared"}).${projLabel ? ` ${projLabel}.` : ""}`,
      });
      close(false);
    } catch (err: any) {
      toast({ title: "Bulk assignment failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="dialog-bulk-assign">
        <DialogHeader>
          <DialogTitle>Bulk role assignment</DialogTitle>
          <DialogDescription>
            Apply one user to one role across many clients in a single department. You'll see a preview before anything
            changes.
          </DialogDescription>
        </DialogHeader>

        {step === "pick" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Department</Label>
                <Select
                  value={departmentId}
                  onValueChange={(v) => {
                    setDepartmentId(v);
                    if (departments.find((department) => department.id === v)?.roleCapabilities?.checker !== true && role === "checker") {
                      setRole("primary");
                    }
                    setUserId("");
                    setSelected(new Set());
                  }}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="select-bulk-department">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as AssignableRoleKey)}>
                  <SelectTrigger className="h-9 text-sm" data-testid="select-bulk-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Doer</SelectItem>
                    {selectedDepartmentSupportsChecker && <SelectItem value="checker">Checker</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Assign to</Label>
                <Select
                  value={departmentId ? userId || SELECT_NONE_VALUE : ""}
                  onValueChange={(v) => setUserId(v === SELECT_NONE_VALUE ? "" : v)}
                  disabled={!departmentId}
                >
                  <SelectTrigger className="h-9 text-sm" data-testid="select-bulk-user">
                    <SelectValue placeholder={departmentId ? "Choose…" : "Pick a department first"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SELECT_NONE_VALUE}>Clear (no one)</SelectItem>
                    {deptUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {departmentId && deptUsers.length === 0 && (
                  <p className="text-[11px] text-amber-600">
                    This department has no active members.{" "}
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2"
                      onClick={() => {
                        close(false);
                        onManageMembers(departmentId);
                      }}
                      data-testid="button-bulk-manage-members"
                    >
                      Manage members
                    </button>
                  </p>
                )}
              </div>
            </div>

            {departmentId && (
              <div className="space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <Label className="text-xs">
                    Target clients ({selected.size} of {deptRows.length} selected)
                  </Label>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" onClick={selectAll} data-testid="button-select-all-clients">
                      Select all
                    </Button>
                    <Button variant="outline" size="sm" onClick={selectGapsOnly} data-testid="button-select-gaps-only">
                      Missing {ROLE_LABELS[role]} only
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} data-testid="button-select-none">
                      Clear
                    </Button>
                  </div>
                </div>
                <Input
                  placeholder="Filter clients…"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  className="h-8 text-sm"
                  data-testid="input-bulk-client-search"
                />
                <div className="rounded-md border max-h-64 overflow-y-auto divide-y">
                  {visibleClients.map((r) => {
                    const field = ASSIGNABLE_ROLE_FIELD[role];
                    return (
                      <label
                        key={r.clientId}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/50"
                        data-testid={`bulk-client-row-${r.clientId}`}
                      >
                        <Checkbox checked={selected.has(r.clientId)} onCheckedChange={() => toggle(r.clientId)} />
                        <span className="flex-1">{r.firmName}</span>
                        <span className="text-xs text-muted-foreground">
                          {r[field] ? userName(r[field]) : `no ${ROLE_LABELS[role]}`}
                        </span>
                      </label>
                    );
                  })}
                  {visibleClients.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground">No clients match.</div>
                  )}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => setStep("preview")}
                disabled={!departmentId || selected.size === 0}
                data-testid="button-bulk-preview"
              >
                Preview changes ({selected.size})
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4" data-testid="bulk-preview">
            <div className="text-sm">
              Set <span className="font-semibold">{ROLE_LABELS[role]}</span> to{" "}
              <span className="font-semibold">{userId ? userName(userId) : "no one (clear)"}</span> for{" "}
              <span className="font-semibold">{preview.length}</span> client{preview.length !== 1 ? "s" : ""}.
              {overwriteCount > 0 && (
                <span className="text-amber-600"> {overwriteCount} existing assignment{overwriteCount !== 1 ? "s" : ""} will be overwritten.</span>
              )}
            </div>
            <div className="rounded-md border max-h-72 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Client</TableHead>
                    <TableHead className="text-xs">Current {ROLE_LABELS[role]}</TableHead>
                    <TableHead className="text-xs">New {ROLE_LABELS[role]}</TableHead>
                    <TableHead className="text-xs" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.map((p) => (
                    <TableRow key={p.clientId} data-testid={`preview-row-${p.clientId}`}>
                      <TableCell className="text-sm py-1.5">{p.firmName}</TableCell>
                      <TableCell className="text-sm py-1.5">{p.currentUserId ? userName(p.currentUserId) : "—"}</TableCell>
                      <TableCell className="text-sm py-1.5">{userId ? userName(userId) : "—"}</TableCell>
                      <TableCell className="py-1.5">
                        {p.overwrite ? (
                          <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800 text-[10px]">
                            Overwrite
                          </Badge>
                        ) : p.unchanged ? (
                          <Badge variant="outline" className="text-[10px]">
                            No change
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800 text-[10px]">
                            Fill
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep("pick")} disabled={applying} data-testid="button-bulk-back">
                Back
              </Button>
              <Button onClick={apply} disabled={applying} data-testid="button-bulk-apply">
                {applying ? "Applying…" : `Apply to ${preview.length} client${preview.length !== 1 ? "s" : ""}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RoleColumnSetupSection({
  query,
}: {
  query: {
    data?: CanonicalRoleColumnPreflight | null;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => Promise<unknown>;
  };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [selectedFieldIds, setSelectedFieldIds] = useState<Record<string, string>>({});
  const preflight = query.data;
  const fields = preflight?.fields ?? [];
  const columns = preflight?.roleColumns ?? [];
  const mappedClients = (preflight?.mappings ?? []).filter(
    (mapping) => mapping.observedSyncState === "verified",
  ).length;
  const readyCount = columns.filter((column) => column.ready).length;

  async function saveColumn(
    column: CanonicalRoleColumn,
    field: CanonicalRoleField,
    ownerApproval?: "approve",
  ) {
    if (!preflight?.workspaceId) {
      toast({
        title: "Workspace setup is incomplete",
        description: "Set the Service Desk ClickUp workspace before mapping role columns.",
      });
      return;
    }
    const key = `${column.departmentId}:${column.responsibility}`;
    setSavingKey(key);
    try {
      const response = await apiRequest(
        "PUT",
        "/api/service-desk/role-projections/destinations",
        {
          workspaceId: preflight.workspaceId,
          departmentId: column.departmentId,
          responsibility: column.responsibility,
          environment: "production",
          listId: preflight.canonicalListId,
          targetKind: "client_list_parent",
          peopleFieldId: field.id,
          peopleFieldLabel: field.label,
          peopleFieldType: field.type.toLowerCase(),
          enabled: false,
          ...(ownerApproval ? { ownerApproval } : {}),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((body as { error?: string }).error ?? "Role column was not saved");
      await Promise.all([
        query.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/service-desk/role-projections/status"] }),
      ]);
      toast({
        title: ownerApproval ? "Owner approval recorded" : "ClickUp role field mapped",
        description: "Projection remains paused until sandbox evidence and all required approvals are complete.",
      });
    } catch (error: any) {
      toast({
        title: "Role column was not changed",
        description: error?.message ?? String(error),
      });
    } finally {
      setSavingKey(null);
    }
  }

  if (!query.isLoading && !query.isError && !preflight?.available) {
    return (
      <section className="border bg-card px-4 py-3" data-testid="role-column-setup-section">
        <h3 className="text-sm font-semibold">ClickUp role columns</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The canonical Client List could not be freshly read. No role field can be mapped or approved until it is available.
        </p>
        <Button
          className="mt-3"
          variant="outline"
          size="sm"
          onClick={() => void query.refetch()}
          data-testid="button-recheck-role-columns"
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Recheck
        </Button>
      </section>
    );
  }

  return (
    <section className="border bg-card" data-testid="role-column-setup-section">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">ClickUp role columns</h3>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
            Create missing one-person People fields in ClickUp’s canonical Client List, then choose the exact field ID below.
            The ClickUp label is shown as descriptive metadata; the NoBull role and exact field ID remain the mapping identity.
            Company-scoped and inactive departments are intentionally excluded.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" data-testid="role-column-readiness">
            {readyCount} of {columns.length} ready · {mappedClients} mapped client{mappedClients !== 1 ? "s" : ""}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isLoading}
            aria-label="Recheck ClickUp role columns"
            data-testid="button-recheck-role-columns"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${query.isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Reading canonical ClickUp field metadata…</div>
      ) : query.isError ? (
        <div className="px-4 py-3 text-xs text-muted-foreground" role="status">
          {query.error?.message ?? "ClickUp role-column setup is available to the company owner."}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table data-testid="role-column-setup-table">
            <TableHeader>
              <TableRow>
                <TableHead>NoBull role</TableHead>
                <TableHead>Exact ClickUp field</TableHead>
                <TableHead>Validation</TableHead>
                <TableHead>Approvals</TableHead>
                <TableHead className="text-right">Setup</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((column) => {
                const key = `${column.departmentId}:${column.responsibility}`;
                const saving = savingKey === key;
                const usedFieldIds = new Set(
                  columns
                    .filter(
                      (other) =>
                        other.destination &&
                        (
                          other.departmentId !== column.departmentId ||
                          other.responsibility !== column.responsibility
                        ),
                    )
                    .map((other) => other.destination!.peopleFieldId),
                );
                const candidates = fields.filter(
                  (field) =>
                    ["users", "people"].includes(field.type.toLowerCase()) &&
                    (field.observedMaxCardinality === null || field.observedMaxCardinality <= 1) &&
                    !usedFieldIds.has(field.id),
                );
                const mappedField = column.field;
                const selectedFieldId = selectedFieldIds[key] ?? "";
                const selectedField = candidates.find((field) => field.id === selectedFieldId) ?? null;
                const fieldForSave = mappedField ?? selectedField;
                const canMap = !column.destination && !!fieldForSave && !!preflight?.workspaceId;
                const canApprove =
                  !!column.destination &&
                  !!mappedField &&
                  !column.destination.ownerApprovedAt &&
                  column.issues.length === 0;

                return (
                  <TableRow key={key} data-testid={`role-column-row-${column.departmentId}-${column.responsibility}`}>
                    <TableCell className="min-w-48">
                      <div className="font-medium">NoBull role: {column.expectedLabel}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {column.departmentName} · {column.responsibility === "doer" ? "Doer" : "Checker"}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-52">
                      {mappedField ? (
                        <>
                          <div className="break-all text-xs font-medium">{mappedField.label}</div>
                          <div className="break-all text-xs font-medium">{mappedField.id}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {mappedField.type} · max observed {mappedField.observedMaxCardinality ?? "not yet present"}
                          </div>
                        </>
                      ) : !column.destination ? (
                        <Select
                          value={selectedFieldId || SELECT_NONE_VALUE}
                          onValueChange={(value) =>
                            setSelectedFieldIds((current) => ({
                              ...current,
                              [key]: value === SELECT_NONE_VALUE ? "" : value,
                            }))
                          }
                        >
                          <SelectTrigger
                            className="h-9 min-w-64 text-left"
                            data-testid={`select-role-column-field-${column.departmentId}-${column.responsibility}`}
                          >
                            <SelectValue placeholder="Choose a ClickUp People field" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SELECT_NONE_VALUE}>Choose a field</SelectItem>
                            {candidates.map((field) => (
                              <SelectItem key={field.id} value={field.id}>
                                <span className="font-medium">{field.label}</span>
                                <span className="ml-2 text-xs text-muted-foreground">({field.id})</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">No exact field is mapped</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-48">
                      {column.ready ? (
                        <Badge variant="secondary" className="bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300">
                          ID, type & cardinality verified
                        </Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(column.issues.length ? column.issues : ["fresh review required"]).map((issue) => (
                            <Badge key={issue} variant="outline" className="text-caption">
                              {issue.replaceAll("_", " ")}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="min-w-40 text-xs">
                      {column.destination ? (
                        <div className="space-y-1 text-muted-foreground">
                          <div>Sandbox: {column.destination.sandboxExitApprovedAt ? "approved" : "not approved"}</div>
                          <div>Owner: {column.destination.ownerApprovedAt ? "approved" : "not approved"}</div>
                          <div>{column.destination.enabled ? "Enabled" : "Paused"}</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Map a verified field first</span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-52 text-right">
                      {canMap ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={saving}
                          onClick={() => void saveColumn(column, fieldForSave!)}
                          data-testid={`button-map-role-column-${column.departmentId}-${column.responsibility}`}
                        >
                          {saving ? "Mapping…" : "Map field (paused)"}
                        </Button>
                      ) : canApprove ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={saving}
                          onClick={() => void saveColumn(column, fieldForSave!, "approve")}
                          data-testid={`button-approve-role-column-${column.departmentId}-${column.responsibility}`}
                        >
                          {saving ? "Saving…" : "Record owner approval"}
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {!column.destination
                            ? candidates.length > 1
                              ? "Choose one eligible field by its exact ID."
                              : "Choose an eligible one-person People field from the fresh read."
                            : "Fix the listed validation issue, then recheck."}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {preflight?.truncated && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              The response is limited; recheck after resolving visible items.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ProjectionStatusSection({
  query,
  departments,
  onRefresh,
}: {
  query: { data?: { statuses: ProjectionStatusRow[]; environment: string } | null; isLoading: boolean; refetch: () => void };
  departments: SdDepartment[];
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resyncingKey, setResyncingKey] = useState<string | null>(null);

  const deptNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of departments) m.set(d.id, d.name);
    return m;
  }, [departments]);

  const statuses = (query.data?.statuses ?? []).filter(
    (status) => status.responsibility === "doer" || status.responsibility === "checker",
  );
  const environment = query.data?.environment ?? "unconfigured";

  // Don't render if unconfigured or no problem rows
  if (!query.isLoading && (environment === "unconfigured" || statuses.length === 0)) {
    return null;
  }

  async function handleResync(row: ProjectionStatusRow) {
    const key = `${row.clientId}:${row.departmentId}:${row.responsibility}`;
    setResyncingKey(key);
    try {
      const res = await apiRequest("POST", "/api/service-desk/role-projections/resync", {
        clientId: row.clientId,
        departmentId: row.departmentId,
        responsibility: row.responsibility,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as any)?.error ?? "Resync failed");
      }
      // Refresh status after resync
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/role-projections/status"] });
      toast({ title: "Re-sync queued", description: (body as any)?.message ?? "Command reset to pending." });
    } catch (err: any) {
      // Non-destructive: ClickUp resync failure doesn't affect NoBull
      toast({ title: "Re-sync failed", description: err?.message ?? String(err) });
    } finally {
      setResyncingKey(null);
    }
  }

  return (
    <div
      className="border bg-card"
      data-testid="projection-status-section"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <h3 className="text-sm font-semibold text-foreground">ClickUp Projection Issues</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Rows needing attention. NoBull assignments are unaffected.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          aria-label="Refresh projection status"
          data-testid="button-refresh-projection-status"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${query.isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {query.isLoading ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Checking ClickUp projection status…</div>
      ) : (
        <div className="divide-y" data-testid="projection-status-list">
          {statuses.map((row) => (
            <ProjectionStatusCard
              key={`${row.clientId}:${row.departmentId}:${row.responsibility}`}
              row={row}
              deptName={deptNameById.get(row.departmentId)}
              onResync={handleResync}
              resyncingKey={resyncingKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}
