import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { projectionToastLabel } from "@/components/ui/ClickUpProjectionStatus";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SELECT_NONE_VALUE } from "@/lib/constants";
import { DepartmentMembersDialog } from "@/components/admin/DepartmentMembersDialog";
import { CheckCircle, XCircle, AlertCircle, Clock, Plus, Trash2, Pencil, RefreshCw, ExternalLink, TicketCheck, ListChecks, ChevronUp, ChevronDown, Check, X, Wand2 } from "lucide-react";
import { Link } from "wouter";
import { PageHeader } from "@/components/admin/PageHeader";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SdDepartment {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  /** Task #4171 — "company" departments hold roles once, company-wide. */
  assignmentScope?: "per_client" | "company";
  defaultPrimaryUserId?: string | null;
  defaultCheckerUserId?: string | null;
  roleCapabilities?: {
    checker: boolean;
  };
  /** Active-member count, included by GET /api/service-desk/departments (Task #4002). */
  memberCount?: number;
  /** Per-client assignment rows with at least one role holder (Task #4173). */
  assignmentCount?: number;
  /** MAX(updated_at) over those rows — the "how stale is this data" hint (Task #4173). */
  lastAssignmentUpdatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SdDepartmentMember {
  id: string;
  departmentId: string;
  userId: string;
  clickupUserId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Task #4892 — cascade counts a permanent delete would remove or untag.
 *  Keys mirror the DELETE response's cascade object exactly. */
interface DeptDeleteImpact {
  memberRows: number;
  clientAssignmentRows: number;
  requestTypes: number;
  requestTypeQuestions: number;
  requestTypeChecklistSteps: number;
  checklistStepOverridesCleared: number;
  ticketMappingsUntagged: number;
  optionMapEntriesRemoved: number;
  projectionCommands: number;
  projectionClientTargets: number;
  projectionDestinations: number;
  clickupOptionIds: string[];
}
interface SdRequestType {
  id: string;
  departmentId: string | null;
  name: string;
  description: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface SdListMapping {
  id: string;
  clickupListId: string | null;
  clickupSpaceId: string | null;
  clickupFolderId: string | null;
  clickupWorkspaceId: string | null;
  fieldClientId: string | null;
  fieldDepartmentId: string | null;
  fieldOwnerDeptId: string | null;
  fieldRequestTypeId: string | null;
  fieldRequesterId: string | null;
  fieldRequestedDateId: string | null;
  fieldCommittedDateId: string | null;
  fieldWaitingWhoId: string | null;
  fieldWaitingWhatId: string | null;
  fieldWaitingWhenId: string | null;
  /** ClickUp option UUID → NoBull department ID. Saved as JSON in sd_list_mapping. */
  departmentOptionIds: Record<string, string> | null;
  /** ClickUp option UUID → NoBull request type label. Saved as JSON in sd_list_mapping. */
  requestTypeOptionIds: Record<string, string> | null;
  /** ClickUp option UUID → NoBull clients.id (UUID). Populated by "Sync client options". */
  clientOptionIds: Record<string, string> | null;
  masterFormUrl: string | null;
  masterFormEmbedUrl: string | null;
  setupStep: string;
}

interface CuDropdownOption {
  id: string;
  name: string;
  nobullDepartmentId?: string | null;
  nobullRequestTypeId?: string | null;
  nobullClientId?: string | null;
}

interface AiSuggestion {
  optionId: string;
  optionName: string;
  clientId: string;
  firmName: string;
}

interface SyncClientOptionsResult {
  matched: Array<{ optionId: string; optionName: string; clientId: string; firmName: string; autoMatched: boolean }>;
  unmatchedOptions: Array<{ optionId: string; optionName: string }>;
  clientsWithoutOption: Array<{ clientId: string; firmName: string }>;
  savedMap: Record<string, string>;
  autoMatchedCount: number;
  suggestions: AiSuggestion[];
  suggestionsNote?: string;
  note?: string;
}

interface ImportDepartmentsResult {
  matched: Array<{ optionId: string; optionName: string; departmentId: string }>;
  alreadyMapped: Array<{ optionId: string; optionName: string; departmentId: string }>;
  unknown: Array<{ optionId: string; optionName: string; reason: "no_local_department" | "stale_mapping" }>;
  renamed?: Array<{ optionId: string; departmentId: string; oldName: string; newName: string }>;
  matchedCount: number;
  alreadyMappedCount: number;
  unknownCount: number;
  renamedCount?: number;
  note?: string;
}

interface RefreshOptionNamesResult {
  departmentsRenamed: Array<{ optionId: string; departmentId: string; oldName: string; newName: string }>;
  requestTypesRenamed: Array<{ optionId: string; requestTypeId: string; oldName: string; newName: string }>;
  departmentsRenamedCount: number;
  requestTypesRenamedCount: number;
}

interface CheckItem {
  key: string;
  label: string;
  status: "ok" | "missing" | "unchecked" | "manual";
  detail?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function CheckIcon({ status }: { status: CheckItem["status"] }) {
  if (status === "ok")
    return <CheckCircle className="h-4 w-4 text-green-600" data-testid="icon-ok" />;
  if (status === "missing")
    return <XCircle className="h-4 w-4 text-red-500" data-testid="icon-missing" />;
  if (status === "manual")
    return <AlertCircle className="h-4 w-4 text-amber-500" data-testid="icon-manual" />;
  return <Clock className="h-4 w-4 text-muted-foreground" data-testid="icon-unchecked" />;
}

const REQUIRED_STATUSES = [
  "Submitted",
  "Scheduled",
  "In Progress",
  "Needs Information",
  "Waiting on Account Manager",
  "Waiting on Client",
  "Waiting on Approval",
  "Blocked",
  "Quality Review",
  "Delivered",
  "Closed",
  "Reopened",
  "Out of Scope",
  "Canceled",
  "Duplicate",
];

const REQUIRED_FIELDS = [
  { label: "Client", hint: "Dropdown or text" },
  { label: "Department", hint: "Dropdown — one option per department" },
  { label: "Owner Department", hint: "Dropdown — department responsible for fulfillment" },
  { label: "Request Type", hint: "Dropdown — per-department options" },
  { label: "Requester", hint: "Text / email" },
  { label: "Requested Completion Date", hint: "Date field" },
  { label: "Committed Completion Date", hint: "Date field — set by fulfillment owner" },
  { label: "Waiting On", hint: "Text — who the ticket is waiting on" },
  { label: "Action Needed", hint: "Text — what information/action is needed" },
  { label: "Response Needed By", hint: "Date — target response date" },
];

// ─── Sub-panels ────────────────────────────────────────────────────────────────

function SetupPanel({ config }: { config: SdListMapping | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState(config?.clickupWorkspaceId ?? "");

  const clickupStatus = useQuery<{ connected: boolean; status: string }>({
    queryKey: ["/api/integrations/clickup/status"],
    staleTime: 60_000,
  });

  const checks = useQuery<{ checks: CheckItem[] }>({
    queryKey: ["/api/service-desk/setup/verify"],
    staleTime: 30_000,
  });

  const createStructure = useMutation({
    mutationFn: async ({ workspaceId: wsId }: { workspaceId: string }) => {
      const res = await apiRequest("POST", "/api/service-desk/setup/create-structure", { workspaceId: wsId });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "ClickUp structure created", description: `List ID: ${data.listId}` });
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Setup failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const isNotConnected = clickupStatus.data && !clickupStatus.data.connected;

  return (
    <div className="space-y-6">
      {isNotConnected && (
        <div className="flex gap-2 items-start rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800" data-testid="notice-clickup-not-connected">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-medium">Your ClickUp account is not connected.</span>{" "}
            Service Desk setup runs on your own ClickUp account — "Create ClickUp Structure" will fail until you connect.{" "}
            <a href="/profile" className="underline font-medium hover:text-amber-900">Connect on your Profile page →</a>
          </div>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>1. Create ClickUp Structure</CardTitle>
          <CardDescription>
            Creates the Space → Folder → List hierarchy in ClickUp. Idempotent — safe to re-run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 max-w-sm">
            <Label htmlFor="input-workspace-id">ClickUp Workspace ID</Label>
            <Input
              id="input-workspace-id"
              data-testid="input-workspace-id"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="e.g. 12345678"
            />
            <p className="text-xs text-muted-foreground">
              Found in ClickUp URL: app.clickup.com/<strong>WORKSPACE_ID</strong>/home
            </p>
          </div>
          <Button
            data-testid="button-create-structure"
            disabled={!workspaceId.trim() || createStructure.isPending}
            onClick={() => createStructure.mutate({ workspaceId })}
          >
            {createStructure.isPending ? "Creating…" : "Create ClickUp Structure"}
          </Button>
          {config?.clickupListId && (
            <p className="text-sm text-green-700">
              ✓ List bound: <code className="bg-muted px-1 rounded">{config.clickupListId}</code>
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            2. Verify Setup Checklist
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh setup checks"
              data-testid="button-refresh-checks"
              onClick={() => checks.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </CardTitle>
          <CardDescription>
            Auto-checkable items are verified against ClickUp. Manual items require action in ClickUp.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {checks.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : checks.data ? (
            <div className="space-y-3">
              {checks.data.checks.map((c) => (
                <div key={c.key} className="flex gap-3 items-start" data-testid={`check-${c.key}`}>
                  <div className="mt-0.5">
                    <CheckIcon status={c.status} />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{c.label}</p>
                    {c.detail && <p className="text-xs text-muted-foreground">{c.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Manual Steps (Required in ClickUp UI)</CardTitle>
          <CardDescription>
            These items cannot be automated via the ClickUp API and must be set up manually.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h4 className="text-sm font-semibold mb-2">Required Statuses (15)</h4>
            <p className="text-xs text-muted-foreground mb-2">
              Go to the List settings in ClickUp → Statuses → add each status below.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {REQUIRED_STATUSES.map((s) => (
                <Badge key={s} variant="outline" className="text-xs" data-testid={`status-badge-${s.replace(/\s/g, "-")}`}>
                  {s}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-2">Required Custom Fields (10)</h4>
            <p className="text-xs text-muted-foreground mb-2">
              Go to the List settings → Custom Fields → add each field below. Then copy each field's UUID
              into the "Field Mapping" tab.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field Name</TableHead>
                  <TableHead>Type hint</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {REQUIRED_FIELDS.map((f) => (
                  <TableRow key={f.label}>
                    <TableCell className="font-medium text-sm">{f.label}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.hint}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-2">Create the ClickUp Form</h4>
            <p className="text-xs text-muted-foreground">
              Inside the List → Views → Add view → Form. Enable hidden fields: Email, Client, Department,
              Priority. Copy the form URL into the "Config" tab's Master Form URL field. The form URL is
              embedded in the NoBull Service Desk submission page.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function OptionMapsSection({
  config,
  departments,
  requestTypes,
}: {
  config: SdListMapping | null;
  departments: SdDepartment[];
  requestTypes: SdRequestType[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const optionsQuery = useQuery<{
    options: { department: CuDropdownOption[]; requestType: CuDropdownOption[]; client: CuDropdownOption[] };
  }>({
    queryKey: ["/api/service-desk/setup/options"],
    staleTime: 60_000,
    enabled: !!(config?.clickupListId && config?.fieldDepartmentId),
  });

  const [deptMap, setDeptMap] = useState<Record<string, string>>(
    (config?.departmentOptionIds as Record<string, string>) ?? {},
  );
  const [rtMap, setRtMap] = useState<Record<string, string>>(
    (config?.requestTypeOptionIds as Record<string, string>) ?? {},
  );
  const [clientMap, setClientMap] = useState<Record<string, string>>(
    (config?.clientOptionIds as Record<string, string>) ?? {},
  );

  const [syncResult, setSyncResult] = useState<SyncClientOptionsResult | null>(null);
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [rejectedSuggestions, setRejectedSuggestions] = useState<Set<string>>(new Set());

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/service-desk/config", {
        departmentOptionIds: deptMap,
        requestTypeOptionIds: rtMap,
        clientOptionIds: clientMap,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Option maps saved" });
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const syncClientOptions = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/setup/sync-client-options", {});
      return res.json() as Promise<SyncClientOptionsResult>;
    },
    onSuccess: (data) => {
      setSyncResult(data);
      setClientMap(data.savedMap);
      setSuggestions(data.suggestions ?? []);
      setRejectedSuggestions(new Set());
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/options"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
      if (data.autoMatchedCount > 0 || Object.keys(data.savedMap).length > 0) {
        toast({
          title: "Client options synced",
          description: `${data.autoMatchedCount} auto-matched. ${data.unmatchedOptions.length} option(s) need manual pairing. ${data.clientsWithoutOption.length} client(s) without an option.`,
        });
      } else if (data.note) {
        toast({ title: "Sync complete", description: data.note, variant: "destructive" });
      } else {
        toast({ title: "Sync complete", description: "No new auto-matches found." });
      }
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  // Task #3616: refresh NoBull department / request type names for options whose
  // ClickUp label was renamed. Never touches the mappings themselves.
  const refreshNames = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/setup/refresh-option-names", {});
      return res.json() as Promise<RefreshOptionNamesResult>;
    },
    onSuccess: (data) => {
      // Request-type map values are names; keep the local draft in sync so a
      // later "Save Option Maps" doesn't write stale names back.
      if (data.requestTypesRenamed.length > 0) {
        setRtMap((m) => {
          const next = { ...m };
          for (const r of data.requestTypesRenamed) {
            if (next[r.optionId]) next[r.optionId] = r.newName;
          }
          return next;
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/options"] }); // fire-and-forget: cache refresh only
      const total = data.departmentsRenamedCount + data.requestTypesRenamedCount;
      if (total > 0) {
        const parts: string[] = [];
        if (data.departmentsRenamedCount > 0) parts.push(`${data.departmentsRenamedCount} department name(s)`);
        if (data.requestTypesRenamedCount > 0) parts.push(`${data.requestTypesRenamedCount} request type name(s)`);
        toast({
          title: "Names refreshed from ClickUp",
          description: `${parts.join(" and ")} updated to match renamed ClickUp options.`,
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Name refresh failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const acceptSuggestions = useMutation({
    mutationFn: async (pairs: Array<{ optionId: string; clientId: string }>) => {
      const res = await apiRequest("POST", "/api/service-desk/setup/accept-client-suggestions", { pairs });
      return res.json() as Promise<{ accepted: number; savedMap: Record<string, string> }>;
    },
    onSuccess: (data, pairs) => {
      setClientMap(data.savedMap);
      const acceptedIds = new Set(pairs.map((p) => p.optionId));
      setSuggestions((prev) => prev.filter((s) => !acceptedIds.has(s.optionId)));
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
      toast({ title: `${data.accepted} suggestion(s) accepted`, description: "Mappings saved to the option map." });
    },
    onError: (err: any) => {
      toast({ title: "Accept failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  if (!config?.clickupListId) {
    return (
      <p className="text-sm text-muted-foreground">
        Create the ClickUp structure first, then bind field UUIDs in the Config tab.
      </p>
    );
  }
  if (!config?.fieldDepartmentId || !config?.fieldRequestTypeId) {
    return (
      <p className="text-sm text-muted-foreground">
        Bind the Department and Request Type field UUIDs in the Config tab first.
      </p>
    );
  }

  const deptOpts = optionsQuery.data?.options.department ?? [];
  const rtOpts = optionsQuery.data?.options.requestType ?? [];
  const clientOpts = optionsQuery.data?.options.client ?? [];

  // Show gaps from a fresh sync OR from the saved state (options loaded but some are unmapped).
  // This means admins see the gap banner on page load without needing to re-sync.
  const savedStateHasGaps = clientOpts.length > 0 && clientOpts.some((opt) => !clientMap[opt.id]);
  const hasClientGaps =
    (syncResult?.unmatchedOptions.length ?? 0) > 0 ||
    (syncResult?.clientsWithoutOption.length ?? 0) > 0 ||
    savedStateHasGaps;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Department Option Map</CardTitle>
              <CardDescription className="mt-1">
                For each ClickUp "Department" dropdown option, select the matching NoBull department.
                Tickets use this to route to the correct team automatically.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-automatch-departments"
              disabled={deptOpts.length === 0 || departments.length === 0}
              onClick={() => {
                let matched = 0;
                setDeptMap((m) => {
                  const next = { ...m };
                  for (const opt of deptOpts) {
                    if (next[opt.id]) continue;
                    const d = departments.find(
                      (dep) => dep.name.trim().toLowerCase() === opt.name.trim().toLowerCase(),
                    );
                    if (d) {
                      next[opt.id] = d.id;
                      matched++;
                    }
                  }
                  return next;
                });
                toast({
                  title: "Auto-match complete",
                  description: `${matched} department option(s) matched by name. Press "Save Option Maps" to keep them.`,
                });
                // Also refresh NoBull names for options renamed in ClickUp.
                refreshNames.mutate();
              }}
            >
              Auto-match by name
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {optionsQuery.isPending && <p className="text-sm text-muted-foreground">Loading ClickUp options…</p>}
          {optionsQuery.isError && (
            <p className="text-sm text-red-500">Failed to load options — check ClickUp connection.</p>
          )}
          {deptOpts.length === 0 && !optionsQuery.isPending && (
            <p className="text-sm text-muted-foreground">No options found on the Department field in ClickUp.</p>
          )}
          {deptOpts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ClickUp Option</TableHead>
                  <TableHead>NoBull Department</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deptOpts.map((opt) => (
                  <TableRow key={opt.id}>
                    <TableCell className="font-mono text-xs">{opt.name}</TableCell>
                    <TableCell>
                      <select
                        data-testid={`select-dept-opt-${opt.id}`}
                        className="text-xs border rounded px-2 py-1 w-full"
                        value={deptMap[opt.id] ?? ""}
                        onChange={(e) =>
                          setDeptMap((m) => {
                            const next = { ...m };
                            if (e.target.value) next[opt.id] = e.target.value;
                            else delete next[opt.id];
                            return next;
                          })
                        }
                      >
                        <option value="">— unbound —</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Request Type Option Map</CardTitle>
              <CardDescription className="mt-1">
                For each ClickUp "Request Type" dropdown option, assign the NoBull request type label used in ticket routing.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-automatch-request-types"
              disabled={rtOpts.length === 0 || requestTypes.length === 0}
              onClick={() => {
                let matched = 0;
                setRtMap((m) => {
                  const next = { ...m };
                  for (const opt of rtOpts) {
                    if (next[opt.id]) continue;
                    const rt = requestTypes.find(
                      (r) => r.name.trim().toLowerCase() === opt.name.trim().toLowerCase(),
                    );
                    if (rt) {
                      next[opt.id] = rt.name;
                      matched++;
                    }
                  }
                  return next;
                });
                toast({
                  title: "Auto-match complete",
                  description: `${matched} request type option(s) matched by name. Press "Save Option Maps" to keep them.`,
                });
                // Also refresh NoBull names for options renamed in ClickUp.
                refreshNames.mutate();
              }}
            >
              Auto-match by name
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {optionsQuery.isPending && <p className="text-sm text-muted-foreground">Loading ClickUp options…</p>}
          {rtOpts.length === 0 && !optionsQuery.isPending && (
            <p className="text-sm text-muted-foreground">No options found on the Request Type field in ClickUp.</p>
          )}
          {rtOpts.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ClickUp Option</TableHead>
                  <TableHead>NoBull Request Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rtOpts.map((opt) => (
                  <TableRow key={opt.id}>
                    <TableCell className="font-mono text-xs">{opt.name}</TableCell>
                    <TableCell>
                      <select
                        data-testid={`select-rt-opt-${opt.id}`}
                        className="text-xs border rounded px-2 py-1 w-full"
                        value={rtMap[opt.id] ?? ""}
                        onChange={(e) =>
                          setRtMap((m) => {
                            const next = { ...m };
                            if (e.target.value) next[opt.id] = e.target.value;
                            else delete next[opt.id];
                            return next;
                          })
                        }
                      >
                        <option value="">— unbound —</option>
                        {requestTypes.map((rt) => (
                          <option key={rt.id} value={rt.name}>{rt.name}</option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Client Option Map</CardTitle>
              <CardDescription className="mt-1">
                If the Client field in ClickUp is a <strong>Dropdown</strong>, press "Sync client options" to pull
                the options and auto-match them to NoBull clients by firm name. Manual pairing is available for
                options that don't auto-match. Tickets created directly in ClickUp will resolve the correct NoBull
                client by option UUID instead of relying on exact firm-name spelling.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-sync-client-options"
              disabled={!config?.fieldClientId || syncClientOptions.isPending}
              onClick={() => syncClientOptions.mutate()}
              className="flex-shrink-0"
            >
              <RefreshCw className={`h-4 w-4 mr-1.5 ${syncClientOptions.isPending ? "animate-spin" : ""}`} />
              {syncClientOptions.isPending ? "Syncing…" : "Sync client options"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!config?.fieldClientId && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              Bind the Client field UUID in the Config tab first, then sync.
            </p>
          )}

          {hasClientGaps && (
            <div
              className="flex gap-2 items-start rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
              data-testid="banner-client-option-gaps"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <span className="font-medium">Client option gaps detected.</span>{" "}
                {(syncResult?.unmatchedOptions.length ?? 0) > 0 && (
                  <span>{syncResult!.unmatchedOptions.length} ClickUp option(s) have no NoBull client match — pair them below. </span>
                )}
                {(syncResult?.clientsWithoutOption.length ?? 0) > 0 && (
                  <span>{syncResult!.clientsWithoutOption.length} NoBull client(s) have no ClickUp option — add them in ClickUp and re-sync.</span>
                )}
              </div>
            </div>
          )}

          {syncResult?.note && (
            <p className="text-sm text-muted-foreground">{syncResult.note}</p>
          )}

          {/* AI suggestion note — shown when AI was unavailable during sync */}
          {syncResult?.suggestionsNote && (
            <p className="text-sm text-muted-foreground bg-muted/50 border border-border rounded px-3 py-2">
              {syncResult.suggestionsNote}
            </p>
          )}

          {/* AI suggestion panel — shown when there are pending suggestions */}
          {suggestions.filter((s) => !rejectedSuggestions.has(s.optionId)).length > 0 && (
            <div className="rounded border border-purple-200 bg-purple-50 px-3 py-3 space-y-3" data-testid="panel-ai-suggestions">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-purple-900">
                    AI suggestions ({suggestions.filter((s) => !rejectedSuggestions.has(s.optionId)).length})
                  </p>
                  <p className="text-xs text-purple-700 mt-0.5">
                    Review and accept pairings suggested by AI — they are not saved until you accept.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="button-accept-all-suggestions"
                  className="flex-shrink-0 border-purple-300 text-purple-800 hover:bg-purple-100"
                  disabled={acceptSuggestions.isPending}
                  onClick={() => {
                    const pending = suggestions.filter((s) => !rejectedSuggestions.has(s.optionId));
                    acceptSuggestions.mutate(pending.map((s) => ({ optionId: s.optionId, clientId: s.clientId })));
                  }}
                >
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  Accept all
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ClickUp Option</TableHead>
                    <TableHead>Suggested Client</TableHead>
                    <TableHead className="w-28">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suggestions
                    .filter((s) => !rejectedSuggestions.has(s.optionId))
                    .map((s) => (
                      <TableRow key={s.optionId} data-testid={`row-suggestion-${s.optionId}`}>
                        <TableCell className="font-mono text-xs">{s.optionName}</TableCell>
                        <TableCell className="text-sm">{s.firmName}</TableCell>
                        <TableCell>
                          <div className="flex gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`button-accept-suggestion-${s.optionId}`}
                              className="h-7 px-2 text-xs text-green-700 border-green-300 hover:bg-green-50"
                              disabled={acceptSuggestions.isPending}
                              onClick={() => acceptSuggestions.mutate([{ optionId: s.optionId, clientId: s.clientId }])}
                            >
                              <Check className="h-3 w-3 mr-1" />
                              Accept
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              data-testid={`button-reject-suggestion-${s.optionId}`}
                              className="h-7 px-2 text-xs text-muted-foreground"
                              onClick={() => setRejectedSuggestions((prev) => new Set([...prev, s.optionId]))}
                            >
                              <X className="h-3 w-3 mr-1" />
                              Reject
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Live option map — shown after sync or when the saved map already has entries */}
          {(clientOpts.length > 0 || Object.keys(clientMap).length > 0) && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ClickUp Option</TableHead>
                  <TableHead>NoBull Client</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clientOpts.map((opt) => (
                  <TableRow key={opt.id} data-testid={`row-client-opt-${opt.id}`}>
                    <TableCell className="font-mono text-xs">{opt.name}</TableCell>
                    <TableCell>
                      <input
                        data-testid={`input-client-opt-${opt.id}`}
                        className="text-xs border rounded px-2 py-1 w-full font-mono"
                        placeholder="NoBull client UUID"
                        value={clientMap[opt.id] ?? ""}
                        onChange={(e) =>
                          setClientMap((m) => {
                            const next = { ...m };
                            if (e.target.value.trim()) next[opt.id] = e.target.value.trim();
                            else delete next[opt.id];
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      {clientMap[opt.id] ? (
                        <Badge variant="outline" className="text-xs text-green-700 border-green-300">Mapped</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">Gap</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {/* If we have saved map entries but no clientOpts loaded yet, show raw entries */}
                {clientOpts.length === 0 && Object.entries(clientMap).map(([optId, clientId]) => (
                  <TableRow key={optId} data-testid={`row-client-opt-${optId}`}>
                    <TableCell className="font-mono text-xs">{optId}</TableCell>
                    <TableCell className="font-mono text-xs">{clientId}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs text-green-700 border-green-300">Mapped</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {syncResult && clientOpts.length === 0 && !syncResult.note && (
            <p className="text-sm text-muted-foreground">
              No dropdown options found on the Client field. If the field is a text field, option mapping is not needed — NoBull will use firm-name matching instead.
            </p>
          )}

          {syncResult && (syncResult.clientsWithoutOption.length > 0) && (
            <div className="mt-2">
              <p className="text-xs font-semibold text-muted-foreground mb-1">
                NoBull clients with no ClickUp option ({syncResult.clientsWithoutOption.length})
              </p>
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                {syncResult.clientsWithoutOption.slice(0, 15).map((c) => (
                  <li key={c.clientId}>{c.firmName}</li>
                ))}
                {syncResult.clientsWithoutOption.length > 15 && (
                  <li>…and {syncResult.clientsWithoutOption.length - 15} more</li>
                )}
              </ul>
              <p className="text-xs text-muted-foreground mt-1">
                Add a dropdown option in ClickUp for each, then re-sync. The option label should match the firm name exactly for auto-matching.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Button
        data-testid="button-save-option-maps"
        onClick={() => save.mutate()}
        disabled={save.isPending}
      >
        {save.isPending ? "Saving…" : "Save Option Maps"}
      </Button>
    </div>
  );
}

function ConfigPanel({ config }: { config: SdListMapping | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Partial<SdListMapping>>(config ?? {});

  // Sync form state when async config data arrives or changes
  useEffect(() => {
    if (config != null) setForm(config);
  }, [config]);

  const autofillFields = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/setup/autofill-fields");
      return res.json();
    },
    onSuccess: (data: any) => {
      const matched: Array<{ key: string; label: string; fieldId: string }> = Array.isArray(data?.matched)
        ? data.matched
        : [];
      const missing: string[] = Array.isArray(data?.missing) ? data.missing : [];
      // Merge pulled IDs into the local form immediately so a subsequent
      // "Save Config" can never write stale UUIDs back over the autofill.
      if (matched.length > 0) {
        setForm((f) => {
          const next = { ...f };
          for (const m of matched) (next as any)[m.key] = m.fieldId;
          return next;
        });
      }
      if (missing.length > 0) {
        toast({
          title: `Filled ${matched.length} of 10 fields`,
          description: `Not found on the ClickUp list (check the field names there): ${missing.join(", ")}`,
          variant: matched.length > 0 ? "default" : "destructive",
        });
      } else {
        toast({ title: "All 10 field IDs pulled from ClickUp" });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Auto-fill failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const save = useMutation({
    mutationFn: async (body: Partial<SdListMapping>) => {
      const res = await apiRequest("PUT", "/api/service-desk/config", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      const warnings: Array<{ message: string }> = Array.isArray(data?.fieldWarnings)
        ? data.fieldWarnings
        : [];
      if (warnings.length > 0) {
        toast({
          title: "Saved, but some field UUIDs look wrong",
          description: warnings.map((w) => w.message).join(" "),
          variant: "destructive",
        });
      } else {
        toast({ title: "Config saved" });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/verify"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) => {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  function field(key: keyof SdListMapping, label: string, placeholder?: string) {
    // Skip Record fields — they have their own OptionMapsSection
    if (key === "departmentOptionIds" || key === "requestTypeOptionIds") return null;
    return (
      <div className="grid gap-1" key={key}>
        <Label htmlFor={`input-${key}`} className="text-xs">{label}</Label>
        <Input
          id={`input-${key}`}
          data-testid={`input-${key}`}
          value={(form as any)[key] ?? ""}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value || null }))}
          placeholder={placeholder}
          className="font-mono text-xs"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>List Mapping</CardTitle>
          <CardDescription>ClickUp hierarchy IDs. Populated automatically by "Create ClickUp Structure".</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {field("clickupWorkspaceId", "Workspace ID")}
          {field("clickupSpaceId", "Space ID")}
          {field("clickupFolderId", "Folder ID")}
          {field("clickupListId", "List ID")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom Field UUIDs</CardTitle>
          <CardDescription>
            Press "Auto-fill from ClickUp" to pull all field IDs from the connected List by name — or paste
            each field's UUID manually (List → Custom Fields → click a field → copy its ID).
          </CardDescription>
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            data-testid="button-autofill-fields"
            onClick={() => autofillFields.mutate()}
            disabled={autofillFields.isPending}
          >
            {autofillFields.isPending ? "Pulling from ClickUp…" : "Auto-fill from ClickUp"}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {field("fieldClientId", "Client field UUID")}
          {field("fieldDepartmentId", "Department field UUID")}
          {field("fieldOwnerDeptId", "Owner Department field UUID")}
          {field("fieldRequestTypeId", "Request Type field UUID")}
          {field("fieldRequesterId", "Requester field UUID")}
          {field("fieldRequestedDateId", "Requested Completion Date UUID")}
          {field("fieldCommittedDateId", "Committed Completion Date UUID")}
          {field("fieldWaitingWhoId", "Waiting On (who) UUID")}
          {field("fieldWaitingWhatId", "Action Needed (what) UUID")}
          {field("fieldWaitingWhenId", "Response Needed By (when) UUID")}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Form Links</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {field("masterFormUrl", "Master Form URL", "https://forms.clickup.com/…")}
          {field("masterFormEmbedUrl", "Embed URL (iframe src)", "https://forms.clickup.com/…/f/…")}
        </CardContent>
      </Card>

      <Button
        data-testid="button-save-config"
        onClick={() => save.mutate({ ...form })}
        disabled={save.isPending || autofillFields.isPending}
      >
        {save.isPending ? "Saving…" : "Save Config"}
      </Button>
    </div>
  );
}

function DepartmentsPanel({ departments, config }: { departments: SdDepartment[]; config: SdListMapping | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  // Task #4893 — creation-time scope pick, so a company-wide department is
  // born company-wide (never seeded onto per-client surfaces in the interim).
  const [newScope, setNewScope] = useState<"per_client" | "company">("per_client");
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Department whose member editor is open. The editor is a DIALOG at the
  // clicked row (Task #4002) — the old below-the-table panel rendered under
  // 15+ department rows, off-screen, so "Manage members" looked like a no-op.
  const [membersDeptId, setMembersDeptId] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportDepartmentsResult | null>(null);
  // Task #4173 — pending scope flip awaiting confirmation. The Select stays
  // controlled by dept.assignmentScope, so cancelling simply discards this.
  const [pendingScope, setPendingScope] = useState<{ dept: SdDepartment; next: "per_client" | "company" } | null>(null);
  // Task #4892 — inactive department awaiting permanent-delete confirmation.
  const [pendingDelete, setPendingDelete] = useState<SdDepartment | null>(null);

  // Impact preview for the confirmation dialog — fetched fresh on open so the
  // counts reflect the database at press time, not a stale list payload.
  const deleteImpact = useQuery<DeptDeleteImpactResponse>({
    queryKey: ["/api/service-desk/departments", pendingDelete?.id ?? "", "delete-impact"],
    enabled: pendingDelete !== null,
  });

  const hardDelete = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const res = await apiRequest("DELETE", `/api/service-desk/departments/${id}`);
      return res.json() as Promise<{
        success: boolean;
        deleted: { id: string; name: string };
        cascade: Omit<DeptDeleteImpact, "clickupOptionIds">;
      }>;
    },
    onSuccess: (data) => {
      const c = data.cascade;
      const parts: string[] = [];
      if (c.memberRows > 0) parts.push(`${c.memberRows} member row${c.memberRows === 1 ? "" : "s"}`);
      if (c.clientAssignmentRows > 0) parts.push(`${c.clientAssignmentRows} client assignment${c.clientAssignmentRows === 1 ? "" : "s"}`);
      if (c.requestTypes > 0) parts.push(`${c.requestTypes} request type${c.requestTypes === 1 ? "" : "s"}`);
      if (c.ticketMappingsUntagged > 0) parts.push(`${c.ticketMappingsUntagged} ticket${c.ticketMappingsUntagged === 1 ? "" : "s"} untagged`);
      toast({
        title: `"${data.deleted.name}" permanently deleted`,
        description: parts.length > 0 ? `Removed ${parts.join(", ")}.` : "No dependent rows existed.",
      });
      setPendingDelete(null);
      // Departments + coverage drive Role Assignments and the pickers; config +
      // options feed the Option Maps tab (map entry may have been removed);
      // request types can lose department-scoped rows.
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/coverage"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/options"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }); // fire-and-forget: cache refresh only
    },
    onError: (err: any) =>
      toast({ title: "Delete failed", description: err?.message ?? String(err), variant: "destructive" }),
  });

  const add = useMutation({
    mutationFn: async ({ name, assignmentScope }: { name: string; assignmentScope: "per_client" | "company" }) => {
      const res = await apiRequest("POST", "/api/service-desk/departments", { name, assignmentScope });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Department added" });
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      setShowAdd(false);
      setNewName("");
      setNewScope("per_client");
    },
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await apiRequest("PUT", `/api/service-desk/departments/${id}`, { active });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }),
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  // Task #4171 — flip a department between per-client assignments and
  // company-wide roles. Company departments vanish from every per-client
  // surface; their supported role holders live on the department itself.
  const setScope = useMutation({
    mutationFn: async ({ id, assignmentScope }: { id: string; assignmentScope: "per_client" | "company" }) => {
      const res = await apiRequest("PUT", `/api/service-desk/departments/${id}`, { assignmentScope });
      return res.json();
    },
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/coverage"] }); // fire-and-forget: cache refresh only
      toast({
        title: vars.assignmentScope === "company" ? "Now company-wide" : "Now per-client",
        description:
          vars.assignmentScope === "company"
            ? "This department's Doer/Checker are now set once for the whole company (existing per-client rows are kept but inert)."
            : "This department is assignable per client again.",
      });
    },
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      const res = await apiRequest("PUT", `/api/service-desk/departments/${id}`, { name });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      setEditId(null);
    },
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const importDepartments = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/setup/import-departments", {});
      return res.json() as Promise<ImportDepartmentsResult>;
    },
    onSuccess: (data) => {
      setImportResult(data);
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/departments"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/options"] }); // fire-and-forget: cache refresh only
      if (data.note) {
        toast({ title: "Import complete", description: data.note });
      } else {
        const parts: string[] = [];
        if (data.matchedCount > 0) parts.push(`${data.matchedCount} matched to existing`);
        if (data.alreadyMappedCount > 0) parts.push(`${data.alreadyMappedCount} already mapped`);
        if (data.unknownCount > 0) parts.push(`${data.unknownCount} unknown option(s) need review`);
        if ((data.renamedCount ?? 0) > 0) parts.push(`${data.renamedCount} name(s) refreshed from ClickUp`);
        toast({
          title: "Department import reconciled",
          description: parts.length > 0 ? parts.join(", ") + "." : "No changes — all options already mapped.",
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Import failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const canImport = !!(config?.clickupListId && config?.fieldDepartmentId);

  const membersDept = departments.find((d) => d.id === membersDeptId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Departments</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            data-testid="button-import-departments"
            disabled={!canImport || importDepartments.isPending}
            title={!canImport ? "Bind the Department field UUID in the Config tab first" : undefined}
            onClick={() => importDepartments.mutate()}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${importDepartments.isPending ? "animate-spin" : ""}`} />
            {importDepartments.isPending ? "Importing…" : "Import from ClickUp"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-add-department"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>
      </div>

      {!canImport && (
        <p className="text-xs text-muted-foreground">
          To import departments from ClickUp, bind the Department field UUID in the <strong>Field Mapping</strong> tab first.
        </p>
      )}

      {importResult && !importResult.note && (
        <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800" data-testid="banner-import-result">
          <span className="font-medium">Import complete.</span>{" "}
          {importResult.matchedCount > 0 && <span>{importResult.matchedCount} matched to existing. </span>}
          {importResult.alreadyMappedCount > 0 && <span>{importResult.alreadyMappedCount} already mapped. </span>}
          {importResult.unknownCount > 0 && <span>{importResult.unknownCount} unknown ClickUp option(s) need review. </span>}
          {(importResult.renamedCount ?? 0) > 0 && <span>{importResult.renamedCount} name(s) refreshed from ClickUp. </span>}
          {importResult.unknownCount === 0 && importResult.matchedCount === 0 && (
            <span>No new mappings — all options already mapped.</span>
          )}
        </div>
      )}

      {importResult?.note && (
        <p className="text-sm text-muted-foreground" data-testid="banner-import-note">{importResult.note}</p>
      )}

      {showAdd && (
        <Card className="border-dashed">
          <CardContent className="pt-4 flex gap-2">
            <Input
              data-testid="input-new-department-name"
              placeholder="Department name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) add.mutate({ name: newName, assignmentScope: newScope });
              }}
            />
            {/* Task #4893 — same wording as the row Scope toggle below. */}
            <Select value={newScope} onValueChange={(v) => setNewScope(v as "per_client" | "company")}>
              <SelectTrigger className="w-40 shrink-0" data-testid="select-new-department-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="per_client">Per client</SelectItem>
                <SelectItem value="company">Company-wide</SelectItem>
              </SelectContent>
            </Select>
            <Button
              data-testid="button-confirm-add-department"
              size="sm"
              disabled={!newName.trim() || add.isPending}
              onClick={() => add.mutate({ name: newName, assignmentScope: newScope })}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAdd(false);
                setNewScope("per_client");
              }}
            >
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Members</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {departments.map((dept) => (
            <TableRow key={dept.id} data-testid={`row-department-${dept.id}`}>
              <TableCell>
                {editId === dept.id ? (
                  <div className="flex gap-2">
                    <Input
                      data-testid={`input-edit-dept-name-${dept.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-7 text-sm"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && editName.trim())
                          rename.mutate({ id: dept.id, name: editName });
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => rename.mutate({ id: dept.id, name: editName })}
                    >
                      OK
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setEditId(null)}
                    >
                      ✕
                    </Button>
                  </div>
                ) : (
                  <span className="font-medium">{dept.name}</span>
                )}
              </TableCell>
              <TableCell>
                <Switch
                  data-testid={`toggle-dept-active-${dept.id}`}
                  checked={dept.active}
                  onCheckedChange={(val) => toggle.mutate({ id: dept.id, active: val })}
                />
              </TableCell>
              <TableCell>
                <Select
                  value={dept.assignmentScope ?? "per_client"}
                  onValueChange={(v) => {
                    const next = v as "per_client" | "company";
                    if (next === (dept.assignmentScope ?? "per_client")) return;
                    // Task #4173 — confirm before flipping: the change hides
                    // (or resurfaces) existing per-client assignment rows.
                    setPendingScope({ dept, next });
                  }}
                >
                  <SelectTrigger
                    className="h-7 text-xs w-32"
                    data-testid={`select-dept-scope-${dept.id}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="per_client">Per client</SelectItem>
                    <SelectItem value="company">Company-wide</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 flex-wrap">
                  {(dept.memberCount ?? 0) === 0 ? (
                    <Badge
                      variant="secondary"
                      className="bg-amber-50 text-amber-700 border-amber-200 text-xs"
                      data-testid={`badge-dept-member-count-${dept.id}`}
                    >
                      0 members
                    </Badge>
                  ) : (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                      data-testid={`badge-dept-member-count-${dept.id}`}
                    >
                      {dept.memberCount} member{dept.memberCount === 1 ? "" : "s"}
                    </Badge>
                  )}
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    data-testid={`button-dept-members-${dept.id}`}
                    onClick={() => setMembersDeptId(dept.id)}
                  >
                    Manage members
                  </Button>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Edit ${dept.name}`}
                    data-testid={`button-edit-dept-${dept.id}`}
                    onClick={() => {
                      setEditId(dept.id);
                      setEditName(dept.name);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  {/* Task #4892 — permanent delete, inactive rows only
                      (deactivate-then-delete is the two-step safety). */}
                  {!dept.active && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      aria-label={`Permanently delete ${dept.name}`}
                      data-testid={`button-delete-dept-${dept.id}`}
                      onClick={() => setPendingDelete(dept)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <DepartmentMembersDialog
        department={membersDept}
        showRoleDefaults
        onOpenChange={(open) => {
          if (!open) setMembersDeptId(null);
        }}
      />

      {/* Task #4173 — scope-flip confirmation. Cancelling leaves the scope
          untouched (the Select is controlled by the server value). */}
      <Dialog open={pendingScope !== null} onOpenChange={(open) => { if (!open) setPendingScope(null); }}>
        <DialogContent data-testid="dialog-scope-confirm">
          <DialogHeader>
            <DialogTitle>
              {pendingScope?.next === "company"
                ? `Make "${pendingScope?.dept.name}" company-wide?`
                : `Make "${pendingScope?.dept.name}" per-client again?`}
            </DialogTitle>
          </DialogHeader>
          {pendingScope && (
            <div className="space-y-2 text-sm text-muted-foreground" data-testid="text-scope-confirm-body">
              {pendingScope.next === "company" ? (
                <>
                  <p>
                    {(pendingScope.dept.assignmentCount ?? 0) > 0 ? (
                      <><strong className="text-foreground">{pendingScope.dept.assignmentCount} client{(pendingScope.dept.assignmentCount ?? 0) === 1 ? " has" : "s have"} per-client assignment rows</strong> for this department.</>
                    ) : (
                      <>No clients currently have per-client assignment rows for this department.</>
                    )}
                  </p>
                  <p>
                    Those rows are <strong className="text-foreground">kept but go dormant</strong> — they are not
                    deleted, but they stop affecting tickets and disappear from the coverage grid, Client Detail,
                    bulk assign, and the Add Client form. Flipping back later brings them back into effect.
                  </p>
                  <p>
                    Company-wide Doer/Checker are then set from the <strong className="text-foreground">Role
                    Assignments</strong> console.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    {(pendingScope.dept.assignmentCount ?? 0) > 0 ? (
                      <>
                        <strong className="text-foreground">{pendingScope.dept.assignmentCount} dormant per-client
                        assignment row{(pendingScope.dept.assignmentCount ?? 0) === 1 ? "" : "s"}</strong> come back
                        into effect immediately
                        {pendingScope.dept.lastAssignmentUpdatedAt
                          ? <> — last updated {new Date(pendingScope.dept.lastAssignmentUpdatedAt).toLocaleDateString()}, so review them for staleness</>
                          : null}.
                      </>
                    ) : (
                      <>No dormant per-client assignment rows exist for this department — every client starts unassigned.</>
                    )}
                  </p>
                  <p>
                    Ticket roles will again resolve per client (falling back to the department defaults where no
                    client-specific person is set).
                  </p>
                </>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" data-testid="button-scope-cancel" onClick={() => setPendingScope(null)}>
              Cancel
            </Button>
            <Button
              data-testid="button-scope-confirm"
              disabled={setScope.isPending}
              onClick={() => {
                if (!pendingScope) return;
                setScope.mutate(
                  { id: pendingScope.dept.id, assignmentScope: pendingScope.next },
                  { onSettled: () => setPendingScope(null) },
                );
              }}
            >
              {setScope.isPending
                ? "Saving…"
                : pendingScope?.next === "company"
                  ? "Switch to company-wide"
                  : "Switch to per-client"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #4892 — permanent-delete confirmation with live impact counts.
          Only reachable from inactive rows; the server independently enforces
          the inactive-first guard (409) and CEO role. */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <DialogContent data-testid="dialog-delete-department">
          <DialogHeader>
            <DialogTitle>Permanently delete "{pendingDelete?.name}"?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              This cannot be undone. The department is removed everywhere, including this
              setup tab. Historical tickets are kept and stay searchable — they just lose
              their department tag.
            </p>
            {deleteImpact.isLoading ? (
              <p data-testid="text-delete-impact-loading">Loading impact…</p>
            ) : deleteImpact.data ? (
              <>
                <ul className="list-disc pl-5 space-y-1" data-testid="list-delete-impact">
                  <li>
                    <strong className="text-foreground">{deleteImpact.data.impact.memberRows}</strong> member row{deleteImpact.data.impact.memberRows === 1 ? "" : "s"} deleted
                  </li>
                  <li>
                    <strong className="text-foreground">{deleteImpact.data.impact.clientAssignmentRows}</strong> per-client role assignment{deleteImpact.data.impact.clientAssignmentRows === 1 ? "" : "s"} deleted
                  </li>
                  <li>
                    <strong className="text-foreground">{deleteImpact.data.impact.requestTypes}</strong> department-scoped request type{deleteImpact.data.impact.requestTypes === 1 ? "" : "s"} deleted
                    {(deleteImpact.data.impact.requestTypeQuestions > 0 || deleteImpact.data.impact.requestTypeChecklistSteps > 0) && (
                      <> (with {deleteImpact.data.impact.requestTypeQuestions} question{deleteImpact.data.impact.requestTypeQuestions === 1 ? "" : "s"} and {deleteImpact.data.impact.requestTypeChecklistSteps} checklist step{deleteImpact.data.impact.requestTypeChecklistSteps === 1 ? "" : "s"})</>
                    )}
                  </li>
                  <li>
                    <strong className="text-foreground">{deleteImpact.data.impact.ticketMappingsUntagged}</strong> ticket{deleteImpact.data.impact.ticketMappingsUntagged === 1 ? "" : "s"} lose the department tag (tickets and their history are kept)
                  </li>
                  <li>
                    <strong className="text-foreground">{deleteImpact.data.impact.projectionDestinations}</strong> ClickUp role-projection destination{deleteImpact.data.impact.projectionDestinations === 1 ? "" : "s"},
                    {" "}<strong className="text-foreground">{deleteImpact.data.impact.projectionClientTargets}</strong> target{deleteImpact.data.impact.projectionClientTargets === 1 ? "" : "s"}, and
                    {" "}<strong className="text-foreground">{deleteImpact.data.impact.projectionCommands}</strong> pending command{deleteImpact.data.impact.projectionCommands === 1 ? "" : "s"} deleted
                  </li>
                  {deleteImpact.data.impact.checklistStepOverridesCleared > 0 && (
                    <li>
                      <strong className="text-foreground">{deleteImpact.data.impact.checklistStepOverridesCleared}</strong> checklist-step assignee override{deleteImpact.data.impact.checklistStepOverridesCleared === 1 ? "" : "s"} on other request types fall back to the ticket's department
                    </li>
                  )}
                </ul>
                {deleteImpact.data.impact.optionMapEntriesRemoved > 0 ? (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800" data-testid="warning-clickup-option">
                    A ClickUp dropdown option still maps to this department; its map entry will be
                    removed here, but the option itself must be deleted <strong>in ClickUp</strong> (the
                    API is read-only for dropdown options). A leftover option is reported for review
                    during import and cannot recreate this department.
                  </div>
                ) : (
                  <p className="text-xs">
                    No ClickUp option currently maps to this department. If a matching dropdown option
                    still exists in ClickUp, remove it there too. Import reports unknown options for
                    review and never creates departments.
                  </p>
                )}
              </>
            ) : deleteImpact.isError ? (
              <p className="text-destructive" data-testid="text-delete-impact-error">
                Could not load the impact preview{(deleteImpact.error as any)?.message ? `: ${(deleteImpact.error as any).message}` : ""}. You can still delete — the same guards run on the server.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" data-testid="button-delete-dept-cancel" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="button-delete-dept-confirm"
              disabled={hardDelete.isPending || deleteImpact.isLoading}
              onClick={() => {
                if (!pendingDelete) return;
                hardDelete.mutate({ id: pendingDelete.id });
              }}
            >
              {hardDelete.isPending ? "Deleting…" : "Permanently delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Template editor dialog ────────────────────────────────────────────────────

function TemplateEditorDialog({
  requestTypeId,
  requestTypeName,
  open,
  onClose,
}: {
  requestTypeId: string;
  requestTypeName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"questions" | "steps">("questions");

  // ── Add-new question state ──────────────────────────────────────────────────
  const [newQLabel, setNewQLabel] = useState("");
  const [newQType, setNewQType] = useState<"text" | "long_text" | "number" | "date" | "yes_no" | "select" | "multi_select">("text");
  const [newQRequired, setNewQRequired] = useState(false);
  const [newQOptions, setNewQOptions] = useState("");
  const [newQHelpText, setNewQHelpText] = useState("");
  const [newQPlaceholder, setNewQPlaceholder] = useState("");
  const [newQDefault, setNewQDefault] = useState("");

  // ── Inline-edit question state ──────────────────────────────────────────────
  const [editingQId, setEditingQId] = useState<string | null>(null);
  const [editQLabel, setEditQLabel] = useState("");
  const [editQType, setEditQType] = useState<"text" | "long_text" | "number" | "date" | "yes_no" | "select" | "multi_select">("text");
  const [editQRequired, setEditQRequired] = useState(false);
  const [editQOptions, setEditQOptions] = useState("");
  const [editQHelpText, setEditQHelpText] = useState("");
  const [editQPlaceholder, setEditQPlaceholder] = useState("");
  const [editQDefault, setEditQDefault] = useState("");

  // ── Add-new step state ──────────────────────────────────────────────────────
  const [newStepName, setNewStepName] = useState("");
  const [newStepAssignee, setNewStepAssignee] = useState("unassigned");
  const [newStepRoleDept, setNewStepRoleDept] = useState("ticket"); // "ticket" | dept id

  // ── Inline-edit step state ──────────────────────────────────────────────────
  const [editingStepId, setEditingStepId] = useState<string | null>(null);
  const [editStepName, setEditStepName] = useState("");
  const [editStepAssignee, setEditStepAssignee] = useState("unassigned");
  const [editStepRoleDept, setEditStepRoleDept] = useState("ticket");

  // Departments for the role department-override picker (a role can resolve
  // against a different department than the ticket's own).
  const deptsQuery = useQuery<{ departments: Array<{ id: string; name: string }> }>({
    queryKey: ["/api/service-desk/departments"],
    enabled: open,
    staleTime: 60_000,
  });
  const departments = deptsQuery.data?.departments ?? [];

  // Team members for the step assignee picker (Task #3656)
  const assigneesQuery = useQuery<{ assignees: Array<{ userId: string; firstName: string | null; lastName: string | null; email: string | null }> }>({
    queryKey: ["/api/service-desk/eligible-assignees"],
    enabled: open,
    staleTime: 60_000,
  });
  const teamMembers = assigneesQuery.data?.assignees ?? [];
  const memberLabel = (m: { firstName: string | null; lastName: string | null; email: string | null }) =>
    `${m.firstName ?? ""} ${m.lastName ?? ""}`.trim() || m.email || "Unknown";

  const qKey = ["/api/service-desk/request-types", requestTypeId, "questions"] as const;
  const sKey = ["/api/service-desk/request-types", requestTypeId, "checklist-steps"] as const;

  const questionsQuery = useQuery({
    queryKey: qKey,
    queryFn: () =>
      apiRequest("GET", `/api/service-desk/request-types/${requestTypeId}/questions`).then((r) => r.json()),
    enabled: open && !!requestTypeId,
  });

  const stepsQuery = useQuery({
    queryKey: sKey,
    queryFn: () =>
      apiRequest("GET", `/api/service-desk/request-types/${requestTypeId}/checklist-steps`).then((r) => r.json()),
    enabled: open && !!requestTypeId,
  });

  const addQuestion = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/service-desk/request-types/${requestTypeId}/questions`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qKey }); // fire-and-forget: cache refresh only
      setNewQLabel(""); setNewQType("text"); setNewQRequired(false); setNewQOptions("");
      setNewQHelpText(""); setNewQPlaceholder(""); setNewQDefault("");
    },
    onError: (err: any) => toast({ title: "Failed to add question", description: err?.message, variant: "destructive" }),
  });

  const updateQuestion = useMutation({
    mutationFn: async ({ id, ...data }: Record<string, unknown> & { id: string }) => {
      const res = await apiRequest("PUT", `/api/service-desk/request-types/${requestTypeId}/questions/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qKey }); // fire-and-forget: cache refresh only
      setEditingQId(null);
    },
    onError: (err: any) => toast({ title: "Failed to update question", description: err?.message, variant: "destructive" }),
  });

  const reorderQuestions = useMutation({
    mutationFn: async (items: { id: string; sortOrder: number }[]) => {
      await Promise.all(
        items.map(({ id, sortOrder }) =>
          apiRequest("PUT", `/api/service-desk/request-types/${requestTypeId}/questions/${id}`, { sortOrder })
        )
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qKey }),
    onError: (err: any) => toast({ title: "Failed to reorder", description: err?.message, variant: "destructive" }),
  });

  const deleteQuestion = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/service-desk/request-types/${requestTypeId}/questions/${id}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qKey }),
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const addStep = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/service-desk/request-types/${requestTypeId}/checklist-steps`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sKey }); // fire-and-forget: cache refresh only
      setNewStepName("");
      setNewStepAssignee("unassigned");
      setNewStepRoleDept("ticket");
    },
    onError: (err: any) => toast({ title: "Failed to add step", description: err?.message, variant: "destructive" }),
  });

  const updateStep = useMutation({
    mutationFn: async ({ id, ...data }: Record<string, unknown> & { id: string }) => {
      const res = await apiRequest("PUT", `/api/service-desk/request-types/${requestTypeId}/checklist-steps/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sKey }); // fire-and-forget: cache refresh only
      setEditingStepId(null);
    },
    onError: (err: any) => toast({ title: "Failed to update step", description: err?.message, variant: "destructive" }),
  });

  const reorderSteps = useMutation({
    mutationFn: async (items: { id: string; sortOrder: number }[]) => {
      await Promise.all(
        items.map(({ id, sortOrder }) =>
          apiRequest("PUT", `/api/service-desk/request-types/${requestTypeId}/checklist-steps/${id}`, { sortOrder })
        )
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sKey }),
    onError: (err: any) => toast({ title: "Failed to reorder", description: err?.message, variant: "destructive" }),
  });

  const deleteStep = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/service-desk/request-types/${requestTypeId}/checklist-steps/${id}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sKey }),
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const questions: any[] = Array.isArray(questionsQuery.data?.questions) ? questionsQuery.data.questions : [];
  const steps: any[] = Array.isArray(stepsQuery.data?.steps) ? stepsQuery.data.steps : [];

  const moveQuestion = (idx: number, direction: -1 | 1) => {
    const newOrder = [...questions];
    const target = idx + direction;
    if (target < 0 || target >= newOrder.length) return;
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    reorderQuestions.mutate(newOrder.map((q, i) => ({ id: q.id, sortOrder: i })));
  };

  const moveStep = (idx: number, direction: -1 | 1) => {
    const newOrder = [...steps];
    const target = idx + direction;
    if (target < 0 || target >= newOrder.length) return;
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    reorderSteps.mutate(newOrder.map((s, i) => ({ id: s.id, sortOrder: i })));
  };

  const startEditQuestion = (q: any) => {
    setEditingQId(q.id);
    setEditQLabel(q.label);
    setEditQType(q.questionType ?? "text");
    setEditQRequired(!!q.required);
    setEditQOptions(Array.isArray(q.options) ? q.options.join("\n") : "");
    setEditQHelpText(q.helpText ?? "");
    setEditQPlaceholder(q.placeholder ?? "");
    setEditQDefault(q.defaultValue ?? "");
  };

  const startEditStep = (s: any) => {
    setEditingStepId(s.id);
    setEditStepName(s.name);
    setEditStepAssignee(encodeStepAssignee(s));
    setEditStepRoleDept(s.assigneeDepartmentId || "ticket");
  };

  // Assignee picker encoding: "unassigned" | "role:<doer|checker>" | "user:<id>".
  // Retired/unknown historical role tokens open as unassigned so an edit can
  // never submit them back as a live assignment.
  const encodeStepAssignee = (s: any): string =>
    s?.assigneeRole === "doer" || s?.assigneeRole === "checker"
      ? `role:${s.assigneeRole}`
      : s?.assigneeUserId
        ? `user:${s.assigneeUserId}`
        : "unassigned";
  const decodeStepAssignee = (
    v: string,
    roleDept: string,
  ): { assigneeUserId: string | null; assigneeRole: string | null; assigneeDepartmentId: string | null } => {
    if (v === "role:doer" || v === "role:checker") {
      return {
        assigneeUserId: null,
        assigneeRole: v.slice(5),
        assigneeDepartmentId: roleDept !== "ticket" ? roleDept : null,
      };
    }
    if (v.startsWith("user:")) return { assigneeUserId: v.slice(5), assigneeRole: null, assigneeDepartmentId: null };
    return { assigneeUserId: null, assigneeRole: null, assigneeDepartmentId: null };
  };
  const ROLE_LABELS: Record<string, string> = {
    doer: "Doer (dynamic)",
    checker: "Checker (dynamic)",
  };
  const stepAssigneeLabel = (s: any): string | null => {
    if (s?.assigneeRole) {
      const base = ROLE_LABELS[s.assigneeRole] ?? s.assigneeRole;
      if (s.assigneeDepartmentId) {
        const d = departments.find((dep) => dep.id === s.assigneeDepartmentId);
        return `${base} · ${d?.name ?? "other dept"}`;
      }
      return base;
    }
    if (s?.assigneeUserId) {
      const m = teamMembers.find((tm) => tm.userId === s.assigneeUserId);
      return m ? memberLabel(m) : "Team member";
    }
    return null;
  };
  const renderAssigneeSelect = (value: string, onChange: (v: string) => void, testId: string) => (
    <select
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border text-sm px-2 py-1.5 bg-background"
    >
      <option value="unassigned">Unassigned</option>
      <optgroup label="Dynamic roles (resolved per client + department)">
        <option value="role:doer">Doer (dynamic)</option>
        <option value="role:checker">Checker (dynamic)</option>
      </optgroup>
      {teamMembers.length > 0 && (
        <optgroup label="Team members">
          {teamMembers.map((m) => (
            <option key={m.userId} value={`user:${m.userId}`}>{memberLabel(m)}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
  // Department the dynamic role resolves against — only shown when a role is
  // selected. "Ticket's department" (default) keeps the previous behavior.
  const renderRoleDeptSelect = (assigneeValue: string, value: string, onChange: (v: string) => void, testId: string) =>
    assigneeValue.startsWith("role:") ? (
      <div className="grid gap-1">
        <Label className="text-xs">Resolve role from department</Label>
        <select
          data-testid={testId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="border text-sm px-2 py-1.5 bg-background"
        >
          <option value="ticket">Ticket's department (default)</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
    ) : null;

  const qTypeOptions = [
    { value: "text", label: "Short text" },
    { value: "long_text", label: "Long text" },
    { value: "number", label: "Number" },
    { value: "date", label: "Date" },
    { value: "yes_no", label: "Yes / No" },
    { value: "select", label: "Dropdown" },
    { value: "multi_select", label: "Multi-select" },
  ];
  const isOptionType = (t: string) => t === "select" || t === "multi_select";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            Template: {requestTypeName}
          </DialogTitle>
        </DialogHeader>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "questions" | "steps")}>
          <TabsList className="w-full">
            <TabsTrigger value="questions" className="flex-1">Intake Questions</TabsTrigger>
            <TabsTrigger value="steps" className="flex-1">Checklist Steps</TabsTrigger>
          </TabsList>

          {/* ── Questions tab ──────────────────────────────────────────────── */}
          <TabsContent value="questions" className="space-y-3 pt-2">
            <p className="text-xs text-muted-foreground">
              Questions shown to the requester on the native submission form.
            </p>
            {questions.map((q, idx) => (
              <div key={q.id} className="rounded border text-sm">
                {editingQId === q.id ? (
                  /* ── Inline edit form ───────────────────────────────────── */
                  <div className="space-y-2 p-3">
                    <div className="grid gap-1">
                      <Label className="text-xs">Question label</Label>
                      <Input
                        data-testid={`input-edit-question-label-${q.id}`}
                        value={editQLabel}
                        onChange={(e) => setEditQLabel(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1 grid gap-1">
                        <Label className="text-xs">Type</Label>
                        <select
                          data-testid={`select-edit-question-type-${q.id}`}
                          value={editQType}
                          onChange={(e) => setEditQType(e.target.value as typeof editQType)}
                          className="border text-sm px-2 py-1.5 bg-background"
                        >
                          {qTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="grid gap-1 items-end pb-0.5">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid={`checkbox-edit-question-required-${q.id}`}
                            checked={editQRequired}
                            onChange={(e) => setEditQRequired(e.target.checked)}
                            className="h-3.5 w-3.5"
                          />
                          Required
                        </label>
                      </div>
                    </div>
                    {isOptionType(editQType) && (
                      <div className="grid gap-1">
                        <Label className="text-xs">Options (one per line)</Label>
                        <Textarea
                          data-testid={`textarea-edit-question-options-${q.id}`}
                          value={editQOptions}
                          onChange={(e) => setEditQOptions(e.target.value)}
                          rows={3}
                          className="text-sm"
                        />
                      </div>
                    )}
                    <div className="grid gap-1">
                      <Label className="text-xs">Help text (shown under the question)</Label>
                      <Input
                        data-testid={`input-edit-question-help-${q.id}`}
                        value={editQHelpText}
                        onChange={(e) => setEditQHelpText(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1 grid gap-1">
                        <Label className="text-xs">Placeholder</Label>
                        <Input
                          data-testid={`input-edit-question-placeholder-${q.id}`}
                          value={editQPlaceholder}
                          onChange={(e) => setEditQPlaceholder(e.target.value)}
                        />
                      </div>
                      <div className="flex-1 grid gap-1">
                        <Label className="text-xs">Default value</Label>
                        <Input
                          data-testid={`input-edit-question-default-${q.id}`}
                          value={editQDefault}
                          onChange={(e) => setEditQDefault(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        data-testid={`button-save-question-${q.id}`}
                        disabled={!editQLabel.trim() || updateQuestion.isPending}
                        onClick={() =>
                          updateQuestion.mutate({
                            id: q.id,
                            label: editQLabel,
                            questionType: editQType,
                            required: editQRequired,
                            options: isOptionType(editQType)
                              ? editQOptions.split("\n").map((s) => s.trim()).filter(Boolean)
                              : [],
                            helpText: editQHelpText.trim() || null,
                            placeholder: editQPlaceholder.trim() || null,
                            defaultValue: editQDefault.trim() || null,
                          })
                        }
                      >
                        <Check className="h-3 w-3 mr-1" />
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid={`button-cancel-edit-question-${q.id}`}
                        onClick={() => setEditingQId(null)}
                      >
                        <X className="h-3 w-3 mr-1" />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* ── Read-only row ─────────────────────────────────────── */
                  <div className="flex items-start gap-1 p-2">
                    <div className="flex flex-col gap-0.5 mr-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        aria-label="Move question up"
                        data-testid={`button-move-question-up-${q.id}`}
                        onClick={() => moveQuestion(idx, -1)}
                        disabled={idx === 0 || reorderQuestions.isPending}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        aria-label="Move question down"
                        data-testid={`button-move-question-down-${q.id}`}
                        onClick={() => moveQuestion(idx, 1)}
                        disabled={idx === questions.length - 1 || reorderQuestions.isPending}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{q.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {q.questionType}{q.required ? " · required" : ""}
                        {Array.isArray(q.options) && q.options.length > 0 ? ` · ${q.options.length} options` : ""}
                      </p>
                    </div>
                    <div className="flex gap-0.5 shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label="Edit question"
                        data-testid={`button-edit-question-${q.id}`}
                        onClick={() => startEditQuestion(q)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label="Delete question"
                        data-testid={`button-delete-question-${q.id}`}
                        onClick={() => deleteQuestion.mutate(q.id)}
                        disabled={deleteQuestion.isPending}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* ── Add new question ─────────────────────────────────────────── */}
            <div className="space-y-2 rounded border border-dashed p-3">
              <div className="grid gap-1">
                <Label className="text-xs">Question label</Label>
                <Input
                  data-testid="input-new-question-label"
                  placeholder="e.g. What is the practice area?"
                  value={newQLabel}
                  onChange={(e) => setNewQLabel(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 grid gap-1">
                  <Label className="text-xs">Type</Label>
                  <select
                    data-testid="select-new-question-type"
                    value={newQType}
                    onChange={(e) => setNewQType(e.target.value as typeof newQType)}
                    className="border text-sm px-2 py-1.5 bg-background"
                  >
                    {qTypeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="grid gap-1 items-end pb-0.5">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="checkbox-new-question-required"
                      checked={newQRequired}
                      onChange={(e) => setNewQRequired(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    Required
                  </label>
                </div>
              </div>
              {isOptionType(newQType) && (
                <div className="grid gap-1">
                  <Label className="text-xs">Options (one per line)</Label>
                  <Textarea
                    data-testid="textarea-new-question-options"
                    placeholder={"Option A\nOption B\nOption C"}
                    value={newQOptions}
                    onChange={(e) => setNewQOptions(e.target.value)}
                    rows={3}
                    className="text-sm"
                  />
                </div>
              )}
              <div className="grid gap-1">
                <Label className="text-xs">Help text (optional, shown under the question)</Label>
                <Input
                  data-testid="input-new-question-help"
                  placeholder="Extra guidance for the requester…"
                  value={newQHelpText}
                  onChange={(e) => setNewQHelpText(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 grid gap-1">
                  <Label className="text-xs">Placeholder (optional)</Label>
                  <Input
                    data-testid="input-new-question-placeholder"
                    value={newQPlaceholder}
                    onChange={(e) => setNewQPlaceholder(e.target.value)}
                  />
                </div>
                <div className="flex-1 grid gap-1">
                  <Label className="text-xs">Default value (optional)</Label>
                  <Input
                    data-testid="input-new-question-default"
                    value={newQDefault}
                    onChange={(e) => setNewQDefault(e.target.value)}
                  />
                </div>
              </div>
              <Button
                size="sm"
                data-testid="button-add-question"
                disabled={!newQLabel.trim() || addQuestion.isPending}
                onClick={() =>
                  addQuestion.mutate({
                    label: newQLabel,
                    questionType: newQType,
                    required: newQRequired,
                    options: isOptionType(newQType)
                      ? newQOptions.split("\n").map((s) => s.trim()).filter(Boolean)
                      : [],
                    helpText: newQHelpText.trim() || null,
                    placeholder: newQPlaceholder.trim() || null,
                    defaultValue: newQDefault.trim() || null,
                    sortOrder: questions.length,
                  })
                }
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Question
              </Button>
            </div>
          </TabsContent>

          {/* ── Steps tab ──────────────────────────────────────────────────── */}
          <TabsContent value="steps" className="space-y-3 pt-2">
            <p className="text-xs text-muted-foreground">
              Checklist items auto-applied to the ClickUp ticket when a ticket of this type is created or first seen.
            </p>
            {steps.map((step, idx) => (
              <div key={step.id} className="rounded border text-sm">
                {editingStepId === step.id ? (
                  /* ── Inline edit form ───────────────────────────────────── */
                  <div className="space-y-2 p-2">
                    <div className="flex items-center gap-2">
                      <Input
                        data-testid={`input-edit-step-name-${step.id}`}
                        value={editStepName}
                        onChange={(e) => setEditStepName(e.target.value)}
                        className="h-7 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && editStepName.trim()) {
                            updateStep.mutate({ id: step.id, name: editStepName, ...decodeStepAssignee(editStepAssignee, editStepRoleDept) });
                          } else if (e.key === "Escape") {
                            setEditingStepId(null);
                          }
                        }}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        aria-label="Save step"
                        data-testid={`button-save-step-${step.id}`}
                        disabled={!editStepName.trim() || updateStep.isPending}
                        onClick={() => updateStep.mutate({ id: step.id, name: editStepName, ...decodeStepAssignee(editStepAssignee, editStepRoleDept) })}
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        aria-label="Cancel editing step"
                        data-testid={`button-cancel-edit-step-${step.id}`}
                        onClick={() => setEditingStepId(null)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                    <div className="grid gap-1">
                      <Label className="text-xs">Assignee</Label>
                      {renderAssigneeSelect(editStepAssignee, setEditStepAssignee, `select-edit-step-assignee-${step.id}`)}
                    </div>
                    <div className="grid gap-1">
                      {renderRoleDeptSelect(editStepAssignee, editStepRoleDept, setEditStepRoleDept, `select-edit-step-role-dept-${step.id}`)}
                    </div>
                  </div>
                ) : (
                  /* ── Read-only row ─────────────────────────────────────── */
                  <div className="flex items-center gap-1 p-2">
                    <div className="flex flex-col gap-0.5 mr-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        aria-label="Move step up"
                        data-testid={`button-move-step-up-${step.id}`}
                        onClick={() => moveStep(idx, -1)}
                        disabled={idx === 0 || reorderSteps.isPending}
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-5 w-5"
                        aria-label="Move step down"
                        data-testid={`button-move-step-down-${step.id}`}
                        onClick={() => moveStep(idx, 1)}
                        disabled={idx === steps.length - 1 || reorderSteps.isPending}
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                    </div>
                    <span className="text-muted-foreground font-mono text-xs w-5 shrink-0">{idx + 1}</span>
                    <span className="flex-1 min-w-0 truncate">
                      {step.name}
                      {stepAssigneeLabel(step) && (
                        <span className="ml-2 text-xs text-muted-foreground" data-testid={`text-step-assignee-${step.id}`}>
                          → {stepAssigneeLabel(step)}
                        </span>
                      )}
                    </span>
                    <div className="flex gap-0.5 shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label="Edit step"
                        data-testid={`button-edit-step-${step.id}`}
                        onClick={() => startEditStep(step)}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        aria-label="Delete step"
                        data-testid={`button-delete-step-${step.id}`}
                        onClick={() => deleteStep.mutate(step.id)}
                        disabled={deleteStep.isPending}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* ── Add new step ─────────────────────────────────────────────── */}
            <div className="space-y-2 rounded border border-dashed p-3">
              <div className="flex gap-2">
                <Input
                  data-testid="input-new-checklist-step"
                  placeholder="Step name…"
                  value={newStepName}
                  onChange={(e) => setNewStepName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newStepName.trim()) {
                      addStep.mutate({ name: newStepName, sortOrder: steps.length, ...decodeStepAssignee(newStepAssignee, newStepRoleDept) });
                    }
                  }}
                />
                <Button
                  size="sm"
                  data-testid="button-add-checklist-step"
                  disabled={!newStepName.trim() || addStep.isPending}
                  onClick={() => addStep.mutate({ name: newStepName, sortOrder: steps.length, ...decodeStepAssignee(newStepAssignee, newStepRoleDept) })}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Assignee (dynamic roles resolve per ticket's client + department)</Label>
                {renderAssigneeSelect(newStepAssignee, setNewStepAssignee, "select-new-step-assignee")}
              </div>
              <div className="grid gap-1">
                {renderRoleDeptSelect(newStepAssignee, newStepRoleDept, setNewStepRoleDept, "select-new-step-role-dept")}
              </div>
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Types for auto-match preview ─────────────────────────────────────────────

interface AutoMatchPreview {
  matched: Array<{
    requestTypeId: string;
    requestTypeName: string;
    prefix: string;
    departmentId: string;
    departmentName: string;
    reason: string;
  }>;
  unmatched: Array<{
    requestTypeId: string;
    requestTypeName: string;
    prefix: string;
    reason: "no_match" | "ambiguous" | "already_assigned";
  }>;
}

// ─── Request types panel ───────────────────────────────────────────────────────

function RequestTypesPanel({
  departments,
  requestTypes,
}: {
  departments: SdDepartment[];
  requestTypes: SdRequestType[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDeptId, setNewDeptId] = useState<string>("");
  const [newDesc, setNewDesc] = useState("");
  const [templateRt, setTemplateRt] = useState<SdRequestType | null>(null);

  const [editingDeptFor, setEditingDeptFor] = useState<string | null>(null);
  const [editingDeptValue, setEditingDeptValue] = useState<string>("");

  const [autoMatchPreview, setAutoMatchPreview] = useState<AutoMatchPreview | null>(null);
  const [autoMatchOpen, setAutoMatchOpen] = useState(false);

  const add = useMutation({
    mutationFn: async ({ name, departmentId, description }: { name: string; departmentId: string | null; description: string | null }) => {
      const res = await apiRequest("POST", "/api/service-desk/request-types", { name, departmentId, description });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Request type added" });
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }); // fire-and-forget: cache refresh only
      setShowAdd(false);
      setNewName("");
      setNewDeptId("");
      setNewDesc("");
    },
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const res = await apiRequest("PUT", `/api/service-desk/request-types/${id}`, { active });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }),
    onError: (err: any) => toast({ title: "Failed", description: err?.message, variant: "destructive" }),
  });

  const updateDept = useMutation({
    mutationFn: async ({ id, departmentId }: { id: string; departmentId: string | null }) => {
      const res = await apiRequest("PUT", `/api/service-desk/request-types/${id}`, { departmentId });
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }); // fire-and-forget: cache refresh only
      setEditingDeptFor(null);
    },
    onError: (err: any) => toast({ title: "Failed to update department", description: err?.message, variant: "destructive" }),
  });

  const autoMatchPreviewMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/request-types/auto-match-departments", { dryRun: true });
      return res.json() as Promise<AutoMatchPreview>;
    },
    onSuccess: (data) => {
      setAutoMatchPreview(data);
      setAutoMatchOpen(true);
    },
    onError: (err: any) => toast({ title: "Preview failed", description: err?.message, variant: "destructive" }),
  });

  const autoMatchApply = useMutation({
    mutationFn: async (matches: AutoMatchPreview["matched"]) => {
      const res = await apiRequest("POST", "/api/service-desk/request-types/auto-match-departments", {
        dryRun: false,
        matches: matches.map((m) => ({ requestTypeId: m.requestTypeId, departmentId: m.departmentId })),
      });
      return res.json() as Promise<{ appliedCount: number }>;
    },
    onSuccess: (data) => {
      toast({ title: "Departments assigned", description: `${data.appliedCount} request type(s) updated.` });
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }); // fire-and-forget: cache refresh only
      setAutoMatchOpen(false);
      setAutoMatchPreview(null);
    },
    onError: (err: any) => toast({ title: "Apply failed", description: err?.message, variant: "destructive" }),
  });

  // NOTE: this queryKey is shared with other panels on this page that use the
  // default queryFn, which returns the raw `{ config }` envelope. React Query
  // caches by key, so this consumer MUST use the same envelope shape and
  // unwrap locally — a custom queryFn here would race the cached shape.
  const { data: configEnvelope } = useQuery<{ config: SdListMapping | null }>({
    queryKey: ["/api/service-desk/config"],
    staleTime: 60_000,
  });
  const config = configEnvelope?.config ?? null;

  const importRequestTypes = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/service-desk/setup/import-request-types", {});
      return res.json() as Promise<{
        createdCount: number;
        matchedCount: number;
        alreadyMappedCount: number;
        renamedCount?: number;
        note?: string;
      }>;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/request-types"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/config"] }); // fire-and-forget: cache refresh only
      void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/setup/options"] }); // fire-and-forget: cache refresh only
      if (data.note) {
        toast({ title: "Import complete", description: data.note });
      } else {
        const parts: string[] = [];
        if (data.createdCount > 0) parts.push(`${data.createdCount} created`);
        if (data.matchedCount > 0) parts.push(`${data.matchedCount} matched to existing`);
        if (data.alreadyMappedCount > 0) parts.push(`${data.alreadyMappedCount} already mapped`);
        if ((data.renamedCount ?? 0) > 0) parts.push(`${data.renamedCount} name(s) refreshed from ClickUp`);
        toast({
          title: "Request types imported",
          description: parts.length > 0 ? parts.join(", ") + "." : "No changes — all options already mapped.",
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Import failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const canImportRts = !!(config?.clickupListId && config?.fieldRequestTypeId);

  const deptMap = new Map(departments.map((d) => [d.id, d.name]));

  const unassignedCount = requestTypes.filter((rt) => rt.active && !rt.departmentId).length;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">Request Types</h3>
          {unassignedCount > 0 && (
            <p className="text-xs text-amber-600 mt-0.5">
              {unassignedCount} type{unassignedCount !== 1 ? "s" : ""} without a department — they show under every department on the form.
            </p>
          )}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            data-testid="button-auto-match-departments"
            disabled={autoMatchPreviewMut.isPending}
            title="Propose department assignments based on each request type's name prefix"
            onClick={() => autoMatchPreviewMut.mutate()}
          >
            <Wand2 className={`h-3.5 w-3.5 mr-1 ${autoMatchPreviewMut.isPending ? "animate-spin" : ""}`} />
            {autoMatchPreviewMut.isPending ? "Analysing…" : "Auto-match departments"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-import-request-types"
            disabled={!canImportRts || importRequestTypes.isPending}
            title={!canImportRts ? "Bind the Request Type field UUID in the Field Mapping tab first" : undefined}
            onClick={() => importRequestTypes.mutate()}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${importRequestTypes.isPending ? "animate-spin" : ""}`} />
            {importRequestTypes.isPending ? "Importing…" : "Import from ClickUp"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="button-add-request-type"
            onClick={() => setShowAdd(true)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add
          </Button>
        </div>
      </div>

      {!canImportRts && (
        <p className="text-xs text-muted-foreground">
          To import request types from ClickUp, bind the Request Type field UUID in the <strong>Field Mapping</strong> tab first.
        </p>
      )}

      {showAdd && (
        <Card className="border-dashed">
          <CardContent className="pt-4 space-y-3">
            <div className="grid gap-1">
              <Label className="text-xs">Name</Label>
              <Input
                data-testid="input-new-request-type-name"
                placeholder="e.g. Remove Practice Area"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Department (blank = global)</Label>
              <select
                data-testid="select-new-request-type-dept"
                value={newDeptId}
                onChange={(e) => setNewDeptId(e.target.value)}
                className="border text-sm px-3 py-1.5 bg-background"
              >
                <option value="">— All departments —</option>
                {departments.filter((d) => d.active).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label className="text-xs">Description (optional)</Label>
              <Input
                data-testid="input-new-request-type-desc"
                placeholder="Short description"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                data-testid="button-confirm-add-request-type"
                disabled={!newName.trim() || add.isPending}
                onClick={() => add.mutate({ name: newName, departmentId: newDeptId || null, description: newDesc || null })}
              >
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="border bg-card overflow-x-auto">
      <Table className="os-sticky-col">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Department</TableHead>
            <TableHead>Active</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {requestTypes.map((rt) => (
            <TableRow key={rt.id} data-testid={`row-request-type-${rt.id}`}>
              <TableCell>
                <div>
                  <p className="font-medium text-sm">{rt.name}</p>
                  {rt.description && (
                    <p className="text-xs text-muted-foreground">{rt.description}</p>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-sm min-w-[200px]">
                {editingDeptFor === rt.id ? (
                  <div className="flex items-center gap-1">
                    <select
                      data-testid={`select-dept-${rt.id}`}
                      value={editingDeptValue}
                      onChange={(e) => setEditingDeptValue(e.target.value)}
                      className="border rounded text-xs px-2 py-1 bg-background flex-1"
                    >
                      <option value="">— All departments —</option>
                      {departments.filter((d) => d.active).map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      data-testid={`button-save-dept-${rt.id}`}
                      disabled={updateDept.isPending}
                      onClick={() => updateDept.mutate({ id: rt.id, departmentId: editingDeptValue || null })}
                    >
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      data-testid={`button-cancel-dept-${rt.id}`}
                      onClick={() => setEditingDeptFor(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-testid={`button-edit-dept-${rt.id}`}
                    className="group flex items-center gap-1.5 hover:text-foreground text-left"
                    onClick={() => {
                      setEditingDeptFor(rt.id);
                      setEditingDeptValue(rt.departmentId ?? "");
                    }}
                  >
                    {rt.departmentId ? (
                      <span>{deptMap.get(rt.departmentId) ?? rt.departmentId}</span>
                    ) : (
                      <span className="text-muted-foreground italic">All departments</span>
                    )}
                    <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60 flex-shrink-0" />
                  </button>
                )}
              </TableCell>
              <TableCell>
                <Switch
                  data-testid={`toggle-rt-active-${rt.id}`}
                  checked={rt.active}
                  onCheckedChange={(val) => toggle.mutate({ id: rt.id, active: val })}
                />
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`button-template-${rt.id}`}
                  onClick={() => setTemplateRt(rt)}
                >
                  <ListChecks className="h-3.5 w-3.5 mr-1" />
                  Template
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>

      <TemplateEditorDialog
        requestTypeId={templateRt?.id ?? ""}
        requestTypeName={templateRt?.name ?? ""}
        open={!!templateRt}
        onClose={() => setTemplateRt(null)}
      />

      <Dialog
        open={autoMatchOpen}
        onOpenChange={(open) => {
          if (!open) { setAutoMatchOpen(false); setAutoMatchPreview(null); }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto" data-testid="dialog-auto-match">
          <DialogHeader>
            <DialogTitle>Auto-match departments by prefix</DialogTitle>
          </DialogHeader>
          {autoMatchPreview && (
            <div className="space-y-4 text-sm">
              {autoMatchPreview.matched.length > 0 ? (
                <div>
                  <p className="font-medium text-green-700 mb-2 flex items-center gap-1.5">
                    <Check className="h-4 w-4" />
                    {autoMatchPreview.matched.length} will be assigned
                  </p>
                  <div className="border divide-y max-h-64 overflow-y-auto">
                    {autoMatchPreview.matched.map((m) => (
                      <div key={m.requestTypeId} className="px-3 py-2 flex items-start justify-between gap-2" data-testid={`match-row-${m.requestTypeId}`}>
                        <span className="text-xs font-medium truncate flex-1">{m.requestTypeName}</span>
                        <span className="text-xs text-muted-foreground shrink-0">→</span>
                        <span className="text-xs text-green-700 font-medium truncate flex-1 text-right">{m.departmentName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-muted-foreground">No new matches found.</p>
              )}

              {autoMatchPreview.unmatched.filter((u) => u.reason !== "already_assigned").length > 0 && (
                <div>
                  <p className="font-medium text-amber-700 mb-2 flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4" />
                    {autoMatchPreview.unmatched.filter((u) => u.reason !== "already_assigned").length} need manual assignment
                  </p>
                  <div className="border divide-y max-h-48 overflow-y-auto">
                    {autoMatchPreview.unmatched
                      .filter((u) => u.reason !== "already_assigned")
                      .map((u) => (
                        <div key={u.requestTypeId} className="px-3 py-2 flex items-center justify-between gap-2" data-testid={`unmatched-row-${u.requestTypeId}`}>
                          <span className="text-xs font-medium truncate flex-1">{u.requestTypeName}</span>
                          <Badge variant="outline" className="text-xs shrink-0">
                            {u.reason === "ambiguous" ? "ambiguous" : "no match"}
                          </Badge>
                        </div>
                      ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Use the inline edit (pencil icon) in the table to assign these manually.
                  </p>
                </div>
              )}

              {autoMatchPreview.unmatched.filter((u) => u.reason === "already_assigned").length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {autoMatchPreview.unmatched.filter((u) => u.reason === "already_assigned").length} type(s) already have a department and were skipped.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="button-cancel-auto-match"
              onClick={() => { setAutoMatchOpen(false); setAutoMatchPreview(null); }}
            >
              Cancel
            </Button>
            <Button
              data-testid="button-confirm-auto-match"
              disabled={!autoMatchPreview?.matched.length || autoMatchApply.isPending}
              onClick={() => autoMatchPreview && autoMatchApply.mutate(autoMatchPreview.matched)}
            >
              {autoMatchApply.isPending
                ? "Applying…"
                : `Assign ${autoMatchPreview?.matched.length ?? 0} type${(autoMatchPreview?.matched.length ?? 0) !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Needs Mapping panel (Task #3078) ──────────────────────────────────────────
// Surfaces tickets whose submitter email couldn't be resolved to a NoBull user.
// CEO can assign the correct requester, re-run automatic mapping, or dismiss
// test/spam submissions from the queue.

interface NeedsMappingTicket {
  clickupTaskId: string;
  name: string;
  status: string | null;
  url: string | null;
  requesterUserId: string | null;
  requesterRaw: string | null;
  clientName: string | null;
  resolvedClientId: string | null;
  departmentId: string | null;
  dateCreated: string | null;
}

interface NoBullUser {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role?: string | null;
}

function userLabel(u: NoBullUser): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name ? `${name} (${u.email ?? "no email"})` : (u.email ?? u.id);
}

// ─── Coverage Panel ────────────────────────────────────────────────────────────
// Shows all active clients × all active departments with coverage status.
// Allows filtering to only missing-coverage rows.

interface CoverageRow {
  clientId: string;
  firmName: string;
  departmentId: string;
  deptName: string;
  primaryUserId: string | null;
  checkerUserId: string | null;
  defaultPrimaryUserId: string | null;
  defaultCheckerUserId?: string | null;
  hasCoverage: boolean;
}

function CoveragePanel({ departments }: { departments: SdDepartment[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filterMissing, setFilterMissing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editRow, setEditRow] = useState<{ clientId: string; departmentId: string } | null>(null);
  const [primaryUserId, setPrimaryUserId] = useState("");
  const [checkerUserId, setCheckerUserId] = useState("");
  const [saving, setSaving] = useState(false);

  const coverageQuery = useQuery<{ rows: CoverageRow[]; departments: SdDepartment[]; membersByDept: Record<string, string[]> }>({
    queryKey: ["/api/service-desk/coverage"],
    staleTime: 30_000,
  });

  const usersQuery = useQuery<NoBullUser[]>({
    queryKey: ["/api/users"],
    staleTime: 60_000,
  });

  const users = usersQuery.data ?? [];
  const membersByDept = coverageQuery.data?.membersByDept ?? {};
  const checkerCapable = (departmentId: string) =>
    departments.find((department) => department.id === departmentId)?.roleCapabilities?.checker === true;
  const hasCheckerDepartments = departments.some((department) => department.roleCapabilities?.checker === true);

  function userName(userId: string | null | undefined): string {
    if (!userId) return "—";
    const u = users.find((u) => u.id === userId);
    if (!u) return userId;
    return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || userId;
  }

  const allRows = coverageQuery.data?.rows ?? [];
  const filteredRows = allRows
    .filter((r) => !filterMissing || !r.hasCoverage)
    .filter((r) =>
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
      const res = await apiRequest("PUT", `/api/service-desk/clients/${editRow.clientId}/assignments/${editRow.departmentId}`, {
        primaryUserId: primaryUserId || null,
        ...(checkerCapable(editRow.departmentId) ? { checkerUserId: checkerUserId || null } : {}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? "Save failed");
      }
      const body = await res.json().catch(() => ({}));
      await queryClient.invalidateQueries({ queryKey: ["/api/service-desk/coverage"] });
      const projLabel = projectionToastLabel((body as any)?.projection);
      toast({ title: "Assignment saved", description: projLabel ?? undefined });
      cancelEdit();
    } catch (err: any) {
      toast({ title: "Save failed", description: err?.message ?? String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const missingCount = allRows.filter((r) => !r.hasCoverage).length;

  if (coverageQuery.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading coverage…</div>;
  }

  if (coverageQuery.isError) {
    return <div className="p-4 text-sm text-red-500">Failed to load coverage.</div>;
  }

  return (
    <div className="space-y-4" data-testid="coverage-panel">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold">Assignment Coverage</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Per-client, per-department Doer and approved Checker assignments.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin/role-assignments">
            <Button variant="outline" size="sm" data-testid="link-role-assignments-tool">
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open company Role Assignments
            </Button>
          </Link>
          {missingCount > 0 && (
            <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200" data-testid="badge-missing-count">
              {missingCount} gap{missingCount !== 1 ? "s" : ""}
            </Badge>
          )}
          <Button
            variant={filterMissing ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterMissing((v) => !v)}
            data-testid="button-filter-missing"
          >
            {filterMissing ? "Show all" : "Show gaps only"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => coverageQuery.refetch()} data-testid="button-refresh-coverage">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <Input
        placeholder="Search client or department…"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="max-w-sm"
        data-testid="input-search-coverage"
      />

      <div className="border bg-card overflow-x-auto">
        <Table className="os-sticky-col">
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Client</TableHead>
              <TableHead className="whitespace-nowrap">Department</TableHead>
              <TableHead className="whitespace-nowrap">Primary Doer</TableHead>
              {hasCheckerDepartments && <TableHead className="whitespace-nowrap">Checker</TableHead>}
              <TableHead className="whitespace-nowrap">Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5 + (hasCheckerDepartments ? 1 : 0)} className="text-center text-sm text-muted-foreground py-8">
                  {filterMissing ? "No coverage gaps found." : "No rows match the search."}
                </TableCell>
              </TableRow>
            )}
            {filteredRows.map((row) => {
              const isEditing =
                editRow?.clientId === row.clientId && editRow?.departmentId === row.departmentId;
              const rowSupportsChecker = checkerCapable(row.departmentId);
              return (
                <TableRow key={`${row.clientId}|${row.departmentId}`} data-testid={`coverage-row-${row.clientId}-${row.departmentId}`}>
                  <TableCell className="text-sm font-medium">{row.firmName}</TableCell>
                  <TableCell className="text-sm">{row.deptName}</TableCell>
                  {isEditing ? (
                    <>
                      {(() => {
                        const deptMemberIds = membersByDept[row.departmentId] ?? [];
                        const deptUsers = users.filter((u) => deptMemberIds.includes(u.id));
                        return (
                          <>
                      <TableCell>
                        <Select
                          value={primaryUserId || SELECT_NONE_VALUE}
                          onValueChange={(v) => setPrimaryUserId(v === SELECT_NONE_VALUE ? "" : v)}
                        >
                          <SelectTrigger className="h-8 text-xs w-40" data-testid="select-primary-coverage">
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
                      </TableCell>
                      {hasCheckerDepartments && (
                        rowSupportsChecker ? <TableCell>
                          <Select
                            value={checkerUserId || SELECT_NONE_VALUE}
                            onValueChange={(v) => setCheckerUserId(v === SELECT_NONE_VALUE ? "" : v)}
                          >
                            <SelectTrigger className="h-8 text-xs w-40" data-testid="select-checker-coverage">
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
                        </TableCell> : (
                          <TableCell className="text-sm text-muted-foreground" data-testid={`checker-unavailable-coverage-${row.departmentId}`}>
                            Not available
                          </TableCell>
                        )
                      )}
                          </>
                        );
                      })()}
                      <TableCell />
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end">
                          <Button size="sm" onClick={saveEdit} disabled={saving} data-testid="button-save-coverage">
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving} data-testid="button-cancel-coverage">
                            Cancel
                          </Button>
                        </div>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell className="text-sm">
                        {row.primaryUserId
                          ? userName(row.primaryUserId)
                          : row.defaultPrimaryUserId
                          ? <span className="text-muted-foreground italic">{userName(row.defaultPrimaryUserId)} (dept default)</span>
                          : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      {hasCheckerDepartments && (
                        rowSupportsChecker ? <TableCell className="text-sm">
                          {row.checkerUserId
                            ? userName(row.checkerUserId)
                            : row.defaultCheckerUserId
                            ? <span className="text-muted-foreground italic">{userName(row.defaultCheckerUserId)} (dept default)</span>
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell> : (
                          <TableCell className="text-sm text-muted-foreground" data-testid={`checker-unavailable-coverage-${row.departmentId}`}>
                            Not available
                          </TableCell>
                        )
                      )}
                      <TableCell>
                        {row.hasCoverage ? (
                          <Badge variant="secondary" className="bg-green-50 text-green-700 border-green-200 text-xs" data-testid={`badge-covered-${row.clientId}-${row.departmentId}`}>Covered</Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-amber-50 text-amber-700 border-amber-200 text-xs" data-testid={`badge-gap-${row.clientId}-${row.departmentId}`}>Gap</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(row)}
                          data-testid={`button-edit-coverage-${row.clientId}-${row.departmentId}`}
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

function NeedsMappingPanel({ departments }: { departments: SdDepartment[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [assignTicket, setAssignTicket] = useState<NeedsMappingTicket | null>(null);
  const [userSearch, setUserSearch] = useState("");

  const deptMap = new Map(departments.map((d) => [d.id, d.name]));

  const needsMapping = useQuery<{
    tickets: NeedsMappingTicket[];
    total?: number;
    dismissedCount?: number;
    configured: boolean;
  }>({
    queryKey: ["/api/service-desk/tickets/needs-mapping"],
    staleTime: 15_000,
  });

  const usersQuery = useQuery<NoBullUser[]>({
    queryKey: ["/api/users"],
    enabled: !!assignTicket,
    staleTime: 60_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/tickets/needs-mapping"] }); // fire-and-forget: cache refresh only
    void queryClient.invalidateQueries({ queryKey: ["/api/service-desk/tickets"] }); // fire-and-forget: cache refresh only
  };

  const assignRequester = useMutation({
    mutationFn: async ({ taskId, requesterUserId }: { taskId: string; requesterUserId: string }) => {
      const res = await apiRequest("POST", `/api/service-desk/tickets/${taskId}/mapping`, { requesterUserId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Requester assigned" });
      setAssignTicket(null);
      setUserSearch("");
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Assignment failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const rerunMapping = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiRequest("POST", `/api/service-desk/tickets/${taskId}/rerun-mapping`, {});
      return res.json();
    },
    onSuccess: (data: { ticket: NeedsMappingTicket | null }) => {
      if (data.ticket?.requesterUserId) {
        toast({ title: "Mapping completed", description: "Submitter resolved to a NoBull user." });
      } else {
        toast({
          title: "Still unmapped",
          description: "No NoBull user matches the submitter email yet. Add the user first, or assign manually.",
        });
      }
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Re-run failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const dismissMapping = useMutation({
    mutationFn: async (taskId: string) => {
      const res = await apiRequest("POST", `/api/service-desk/tickets/${taskId}/dismiss-mapping`, { dismissed: true });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Ticket dismissed", description: "Removed from the unmapped queue." });
      invalidate();
    },
    onError: (err: any) => {
      toast({ title: "Dismiss failed", description: err?.message ?? String(err), variant: "destructive" });
    },
  });

  const tickets = needsMapping.data?.tickets ?? [];
  const allUsers = usersQuery.data ?? [];
  const filteredUsers = userSearch.trim()
    ? allUsers.filter((u) =>
        [u.firstName, u.lastName, u.email]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(userSearch.trim().toLowerCase()),
      )
    : allUsers;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Tickets Needing Mapping
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh tickets needing mapping"
              data-testid="button-refresh-needs-mapping"
              onClick={() => needsMapping.refetch()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </CardTitle>
          <CardDescription>
            Tickets whose submitter email or client name couldn't be matched to NoBull.
            Assign the correct requester, re-run mapping after adding the user, or dismiss test/spam submissions.
            {typeof needsMapping.data?.dismissedCount === "number" && needsMapping.data.dismissedCount > 0 && (
              <> {needsMapping.data.dismissedCount} dismissed ticket(s) are hidden.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {needsMapping.isLoading ? (
            <p className="text-sm text-muted-foreground" data-testid="status-needs-mapping-loading">Loading…</p>
          ) : !needsMapping.data?.configured ? (
            <p className="text-sm text-muted-foreground" data-testid="status-needs-mapping-unconfigured">
              Service desk is not configured yet. Complete Setup first.
            </p>
          ) : tickets.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="status-needs-mapping-empty">
              No tickets need mapping. 🎉
            </p>
          ) : (
            <div className="border bg-card overflow-x-auto">
            <Table className="os-sticky-col">
              <TableHeader>
                <TableRow>
                  <TableHead>Ticket</TableHead>
                  <TableHead>Submitter email</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((t) => (
                  <TableRow key={t.clickupTaskId} data-testid={`row-needs-mapping-${t.clickupTaskId}`}>
                    <TableCell>
                      <div className="max-w-[220px]">
                        <p className="font-medium text-sm truncate" data-testid={`text-ticket-name-${t.clickupTaskId}`}>
                          {t.name}
                        </p>
                        {t.url && (
                          <a
                            href={t.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-muted-foreground underline inline-flex items-center gap-1"
                            data-testid={`link-ticket-${t.clickupTaskId}`}
                          >
                            Open in ClickUp <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm" data-testid={`text-submitter-email-${t.clickupTaskId}`}>
                      {t.requesterUserId ? (
                        <Badge variant="secondary">mapped</Badge>
                      ) : (
                        t.requesterRaw ?? <span className="text-muted-foreground italic">none</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm" data-testid={`text-client-name-${t.clickupTaskId}`}>
                      {t.clientName ?? <span className="text-muted-foreground italic">none</span>}
                      {t.clientName && !t.resolvedClientId && (
                        <Badge variant="outline" className="ml-1">unmatched</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm" data-testid={`text-department-${t.clickupTaskId}`}>
                      {t.departmentId
                        ? deptMap.get(t.departmentId) ?? t.departmentId
                        : <span className="text-muted-foreground italic">none</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {!t.requesterUserId && (
                          <Button
                            size="sm"
                            variant="default"
                            data-testid={`button-assign-requester-${t.clickupTaskId}`}
                            onClick={() => { setAssignTicket(t); setUserSearch(""); }}
                          >
                            Assign requester
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid={`button-rerun-mapping-${t.clickupTaskId}`}
                          disabled={rerunMapping.isPending}
                          onClick={() => rerunMapping.mutate(t.clickupTaskId)}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1" />
                          Re-run mapping
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-600 hover:text-red-700"
                          data-testid={`button-dismiss-mapping-${t.clickupTaskId}`}
                          disabled={dismissMapping.isPending}
                          onClick={() => dismissMapping.mutate(t.clickupTaskId)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                          Dismiss
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!assignTicket} onOpenChange={(open) => { if (!open) { setAssignTicket(null); setUserSearch(""); } }}>
        <DialogContent data-testid="dialog-assign-requester">
          <DialogHeader>
            <DialogTitle>Assign requester</DialogTitle>
          </DialogHeader>
          {assignTicket && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ticket: <span className="font-medium text-foreground">{assignTicket.name}</span>
                {assignTicket.requesterRaw && (
                  <> — submitted by <span className="font-medium text-foreground">{assignTicket.requesterRaw}</span></>
                )}
              </p>
              <Input
                data-testid="input-user-search"
                placeholder="Search users by name or email…"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
              />
              <div className="max-h-64 overflow-y-auto border divide-y">
                {usersQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground p-3">Loading users…</p>
                ) : filteredUsers.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-3" data-testid="status-no-users-found">
                    No users match.
                  </p>
                ) : (
                  filteredUsers.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
                      data-testid={`button-select-user-${u.id}`}
                      disabled={assignRequester.isPending}
                      onClick={() =>
                        assignRequester.mutate({
                          taskId: assignTicket.clickupTaskId,
                          requesterUserId: u.id,
                        })
                      }
                    >
                      {userLabel(u)}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="button-cancel-assign"
              onClick={() => { setAssignTicket(null); setUserSearch(""); }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function ServiceDeskSettings() {
  const { user, isLoading: authLoading } = useAuth();
  const isCeo = !!user && user.role === "ceo";

  const config = useQuery<{ config: SdListMapping | null }>({
    queryKey: ["/api/service-desk/config"],
    enabled: isCeo,
    staleTime: 60_000,
  });

  const departments = useQuery<{ departments: SdDepartment[] }>({
    queryKey: ["/api/service-desk/departments"],
    enabled: isCeo,
    staleTime: 30_000,
  });

  const requestTypes = useQuery<{ requestTypes: SdRequestType[] }>({
    queryKey: ["/api/service-desk/request-types"],
    enabled: isCeo,
    staleTime: 30_000,
  });

  if (authLoading) {
    return <div data-testid="status-loading" className="p-6">Loading…</div>;
  }

  if (!isCeo) {
    return (
      <div className="container mx-auto py-6" data-testid="status-forbidden">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">CEO access required.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const cfg = config.data?.config ?? null;
  const depts = departments.data?.departments ?? [];
  const rts = requestTypes.data?.requestTypes ?? [];

  return (
    <div className="container mx-auto py-6 space-y-6" data-testid="page-service-desk-settings">
      {/* Header — shared admin PageHeader anatomy (Task #4450; audit §6.1-B).
          Existing testids preserved via backTestId/titleTestId. */}
      <PageHeader
        title="Service Desk Settings"
        backHref="/service-desk"
        backLabel="Back to Service Desk"
        backTestId="link-back-to-service-desk"
        titleTestId="heading-service-desk-settings"
        subtitle="Configure the NoBull OS Service Desk ClickUp integration. ClickUp remains the system of record."
        actions={
        <div className="flex items-center gap-2 flex-wrap">
          {cfg?.masterFormEmbedUrl && (
            <Button
              asChild
              variant="default"
              size="sm"
              data-testid="button-create-request-header"
            >
              <Link href="/service-desk/create">
                <TicketCheck className="h-3.5 w-3.5 mr-1.5" />
                Create Request
              </Link>
            </Button>
          )}
          {cfg?.setupStep && (
            <Badge
              variant={cfg.setupStep === "complete" ? "default" : "secondary"}
              data-testid="badge-setup-step"
            >
              {cfg.setupStep}
            </Badge>
          )}
        </div>
        }
      />

      {cfg?.masterFormUrl && (
        <Card className="border-green-200 bg-green-50 dark:bg-green-950/20">
          <CardContent className="py-3 flex items-center gap-3">
            <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
            <span className="text-sm text-green-800 dark:text-green-300">
              Master form configured —{" "}
              <a
                href={cfg.masterFormUrl}
                target="_blank"
                rel="noreferrer"
                className="underline inline-flex items-center gap-1"
                data-testid="link-master-form"
              >
                Open form <ExternalLink className="h-3 w-3" />
              </a>
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="setup">
        <TabsList className="max-w-full flex-wrap h-auto" data-testid="tabs-settings">
          <TabsTrigger value="setup" data-testid="tab-setup">Setup</TabsTrigger>
          <TabsTrigger value="config" data-testid="tab-config">Field Mapping</TabsTrigger>
          <TabsTrigger value="option-maps" data-testid="tab-option-maps">Option Maps</TabsTrigger>
          <TabsTrigger value="departments" data-testid="tab-departments">Departments</TabsTrigger>
          <TabsTrigger value="request-types" data-testid="tab-request-types">Request Types</TabsTrigger>
          <TabsTrigger value="needs-mapping" data-testid="tab-needs-mapping">Needs Mapping</TabsTrigger>
          <TabsTrigger value="coverage" data-testid="tab-coverage">Coverage</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="mt-4">
          <SetupPanel config={cfg} />
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <ConfigPanel config={cfg} />
        </TabsContent>

        <TabsContent value="option-maps" className="mt-4">
          <OptionMapsSection config={cfg} departments={depts} requestTypes={rts} />
        </TabsContent>

        <TabsContent value="departments" className="mt-4">
          {departments.isLoading ? (
            <p className="text-sm text-muted-foreground p-4">Loading departments…</p>
          ) : (
            <DepartmentsPanel departments={depts} config={cfg} />
          )}
        </TabsContent>

        <TabsContent value="request-types" className="mt-4">
          {requestTypes.isLoading ? (
            <p className="text-sm text-muted-foreground p-4">Loading request types…</p>
          ) : (
            <RequestTypesPanel departments={depts} requestTypes={rts} />
          )}
        </TabsContent>

        <TabsContent value="needs-mapping" className="mt-4">
          <NeedsMappingPanel departments={depts} />
        </TabsContent>

        <TabsContent value="coverage" className="mt-4">
          <CoveragePanel departments={depts} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface DeptDeleteImpactResponse {
  department: { id: string; name: string; active: boolean };
  deletable: boolean;
  impact: DeptDeleteImpact;
}
