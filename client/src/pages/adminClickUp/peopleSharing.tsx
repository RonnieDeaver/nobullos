// ClickUp admin — access, people & shared panels + sharing dialog.
// Extracted VERBATIM from the former 10.8k-line ClickUpModule.tsx monolith
// (house aggregator pattern, cf. Task #3787). The page composition root is
// client/src/pages/admin/ClickUpModule.tsx — its size is capped by
// scripts/lint-monolith-aggregator-size.ts, so new ClickUp feature code
// belongs here (or in a new sibling module), never in the aggregator.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  CheckSquare,
  ExternalLink,
  FolderOpen,
  Info,
  Loader2,
  Plus,
  Square,
  Pencil,
  Trash2,
  Users,
  X,
  Shield,
  Globe,
  DollarSign,
  Building,
} from "lucide-react";

// ─── AccessPanel ─────────────────────────────────────────────────────────────
// Shows members with EXPLICIT access only. Inherited-access caveat is
// surfaced per the ClickUp API contract (GetTaskMembers/GetListMembers).

export function AccessPanel({
  type,
  id,
  workspaceId,
}: {
  type: "task" | "list";
  id: string;
  workspaceId: string;
}) {
  const { toast } = useToast();
  const [showSharingDialog, setShowSharingDialog] = useState(false);

  const membersQ = useQuery<{ members: any[]; isPrivate?: boolean | null; inheritedNote: string }>({
    queryKey: [`/api/clickup/${type}s/${id}/members`],
    queryFn: () =>
      fetch(`/api/clickup/${type}s/${id}/members`, { credentials: "include" }).then((r) =>
        r.json(),
      ),
    staleTime: 30_000,
  });

  const members = membersQ.data?.members ?? [];
  const note = membersQ.data?.inheritedNote ?? "";
  // Last-known privacy state from the member fetch (ClickUp includes `private`
  // on task/list objects). null = unknown (fetch failed or field absent).
  const currentPrivate = membersQ.data?.isPrivate ?? null;

  return (
    <div className="space-y-3" data-testid="panel-access">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs font-medium text-gray-700">Explicit Access</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowSharingDialog(true)}
          className="h-6 text-xs px-2"
          data-testid="button-open-sharing"
        >
          <Globe className="w-3 h-3 mr-1" />
          Privacy
        </Button>
      </div>

      {membersQ.isLoading ? (
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading…
        </div>
      ) : membersQ.isError ? (
        <p className="text-xs text-red-500">Could not load members</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-gray-400 italic" data-testid="access-empty">
          No members with explicit access
        </p>
      ) : (
        <div className="space-y-1">
          {members.map((m: any) => {
            const uid = m.id ?? m.user?.id;
            const uname = m.username ?? m.user?.username ?? m.email ?? `User ${uid}`;
            const role = m.role ?? m.user?.role;
            return (
              <div
                key={uid}
                className="flex items-center gap-2 text-xs"
                data-testid={`access-member-${uid}`}
              >
                <div className="w-5 h-5 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-medium text-[10px] flex-shrink-0">
                  {String(uname)[0]?.toUpperCase()}
                </div>
                <span className="text-gray-700 truncate">{uname}</span>
                {role && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto">
                    {role}
                  </Badge>
                )}
              </div>
            );
          })}
        </div>
      )}

      {note && (
        <p className="text-[10px] text-amber-600 flex items-start gap-1 leading-tight">
          <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
          {note}
        </p>
      )}

      {showSharingDialog && (
        <SharingDialog
          type={type === "task" ? 1 : 4}
          id={id}
          workspaceId={workspaceId}
          currentPrivate={currentPrivate}
          onApplied={() => membersQ.refetch()}
          onClose={() => setShowSharingDialog(false)}
        />
      )}
    </div>
  );
}

// ─── SharingDialog ────────────────────────────────────────────────────────────
// ACL privacy update with mandatory cost-warning confirmation.
// API ref: PublicPatchAcl POST /api/v2/team/{team_id}/acl (reviewed 2026-07-16)

export function SharingDialog({
  type,
  id,
  workspaceId,
  currentPrivate,
  onApplied,
  onClose,
}: {
  type: number;
  id: string;
  workspaceId: string;
  /** Last-known privacy state; null when unknown. Pre-fills the toggle. */
  currentPrivate?: boolean | null;
  onApplied?: () => void;
  onClose(): void;
}) {
  const { toast } = useToast();
  // Pre-fill from the current state so applying without touching the toggle
  // is a no-op rather than a silent privacy change. Default to private when unknown.
  const [makePrivate, setMakePrivate] = useState(currentPrivate ?? true);
  const [confirmed, setConfirmed] = useState(false);

  const aclMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/clickup/workspaces/${workspaceId}/acl`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, id, private: makePrivate }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: makePrivate ? "Item is now private" : "Item is now public",
        description: makePrivate
          ? "Only members with explicit access can see it. To share it again, reopen Privacy and turn off \"Make private\"."
          : "Anyone in the workspace can access it. To revert, reopen Privacy and turn \"Make private\" back on.",
      });
      onApplied?.();
      onClose();
    },
    onError: (e: any) =>
      toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Globe className="w-4 h-4 text-blue-500" /> Privacy &amp; Sharing
          </DialogTitle>
          <DialogDescription className="text-xs">
            Update who can access this {type === 1 ? "task" : "list"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Make private</Label>
            <Switch
              checked={makePrivate}
              data-testid="switch-make-private"
              onCheckedChange={(v) => {
                setMakePrivate(v);
                // Require a fresh acknowledgement every time the toggle
                // moves toward public.
                if (!v) setConfirmed(false);
              }}
            />
          </div>
          <p className="text-xs text-gray-500">
            {makePrivate
              ? "Only members with explicit access will see this item."
              : "Anyone in the workspace can access this item."}
          </p>

          {currentPrivate != null && (
            <p className="text-[11px] text-gray-400" data-testid="text-current-privacy">
              Current state: {currentPrivate ? "private" : "public"}
            </p>
          )}

          {!makePrivate && (
            <>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 flex items-start gap-2">
                <DollarSign className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 leading-snug">
                  <strong>Cost notice:</strong> Sharing an item may incur charges depending on
                  your ClickUp plan and the number of guests. Review your plan details before
                  applying. You can revert at any time by turning &quot;Make private&quot; back on.
                </p>
              </div>

              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 accent-amber-600"
                  data-testid="checkbox-cost-confirm"
                />
                <span className="text-xs text-gray-700">
                  I understand this makes the item public and sharing may incur charges.
                </span>
              </label>
            </>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={(!makePrivate && !confirmed) || aclMut.isPending}
            onClick={() => aclMut.mutate()}
            data-testid="button-apply-acl"
          >
            {aclMut.isPending && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SharedPanel ──────────────────────────────────────────────────────────────
// Items explicitly shared with the connected user via
// GET /api/v2/team/{team_id}/shared (reviewed 2026-07-16)

export function SharedPanel({ workspaceId }: { workspaceId: string }) {
  const sharedQ = useQuery<{ tasks: any[]; lists: any[]; folders: any[] }>({
    queryKey: [`/api/clickup/workspaces/${workspaceId}/shared`],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/shared`, {
        credentials: "include",
      }).then((r) => r.json()),
    staleTime: 60_000,
  });

  const tasks = sharedQ.data?.tasks ?? [];
  const lists = sharedQ.data?.lists ?? [];
  const folders = sharedQ.data?.folders ?? [];
  const total = tasks.length + lists.length + folders.length;

  if (sharedQ.isLoading) {
    return (
      <div className="flex items-center gap-2 text-gray-400 text-sm py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading shared items…
      </div>
    );
  }
  if (sharedQ.isError) {
    return <p className="text-sm text-red-500 py-4">Failed to load shared items.</p>;
  }
  if (total === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center h-48 text-gray-400 gap-2"
        data-testid="shared-empty"
      >
        <Globe className="w-6 h-6" />
        <p className="text-xs">No items are explicitly shared with you</p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="panel-shared">
      {tasks.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Shared Tasks ({tasks.length})
          </h3>
          <div className="space-y-0">
            {tasks.map((t: any) => (
              <div
                key={t.id}
                className="flex items-center gap-2 text-xs py-1.5 border-b last:border-b-0"
                data-testid={`shared-task-${t.id}`}
              >
                <CheckSquare className="w-3 h-3 text-purple-400 flex-shrink-0" />
                <span className="flex-1 truncate text-gray-700">{t.name}</span>
                {t.status?.status && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0">
                    {t.status.status}
                  </Badge>
                )}
                {t.url && (
                  <a href={t.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-3 h-3 text-gray-400 hover:text-gray-600" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {lists.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Shared Lists ({lists.length})
          </h3>
          <div className="space-y-0">
            {lists.map((l: any) => (
              <div
                key={l.id}
                className="flex items-center gap-2 text-xs py-1.5 border-b last:border-b-0"
                data-testid={`shared-list-${l.id}`}
              >
                <Square className="w-3 h-3 text-blue-400 flex-shrink-0" />
                <span className="flex-1 truncate text-gray-700">{l.name}</span>
                {l.task_count != null && (
                  <span className="text-[10px] text-gray-400">
                    {l.task_count} task{l.task_count !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {folders.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Shared Folders ({folders.length})
          </h3>
          <div className="space-y-0">
            {folders.map((f: any) => (
              <div
                key={f.id}
                className="flex items-center gap-2 text-xs py-1.5 border-b last:border-b-0"
                data-testid={`shared-folder-${f.id}`}
              >
                <FolderOpen className="w-3 h-3 text-amber-400 flex-shrink-0" />
                <span className="flex-1 truncate text-gray-700">{f.name}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── PeoplePanel ──────────────────────────────────────────────────────────────
// Three sections: workspace member seat info, custom roles read-only,
// and User Group CRUD (create / rename / delete).
// API refs reviewed 2026-07-16:
//   Custom Roles: GET /api/v2/team/{id}/customroles
//   Groups:       GET/POST /api/v2/group, PUT/DELETE /api/v2/group/{id}
//   Seats:        GET /api/v2/team/{id}/seats
//   Plan:         GET /api/v2/team/{id}/plan

export function PeoplePanel({ workspaceId }: { workspaceId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeSection, setActiveSection] = useState<"members" | "roles" | "groups">(
    "members",
  );
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<any | null>(null);
  const [groupName, setGroupName] = useState("");
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);

  const planQ = useQuery<{ plan: string }>({
    queryKey: [`/api/clickup/workspaces/${workspaceId}/plan`],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/plan`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    staleTime: 300_000,
  });

  const seatsQ = useQuery<any>({
    queryKey: [`/api/clickup/workspaces/${workspaceId}/seats`],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/seats`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    staleTime: 60_000,
  });

  const rolesQ = useQuery<{ roles: any[] }>({
    queryKey: [`/api/clickup/workspaces/${workspaceId}/custom-roles`],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/custom-roles`, {
        credentials: "include",
      }).then((r) => r.json()),
    enabled: activeSection === "roles",
    staleTime: 120_000,
  });

  const groupsQ = useQuery<{ groups: any[] }>({
    queryKey: [`/api/clickup/workspaces/${workspaceId}/groups`],
    queryFn: () =>
      fetch(`/api/clickup/workspaces/${workspaceId}/groups`, { credentials: "include" }).then(
        (r) => r.json(),
      ),
    enabled: activeSection === "groups",
    staleTime: 60_000,
  });

  const createGroupMut = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/clickup/workspaces/${workspaceId}/groups`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/api/clickup/workspaces/${workspaceId}/groups`],
      }); // fire-and-forget: cache refresh only
      setShowCreateGroup(false);
      setGroupName("");
      toast({ title: "User group created" });
    },
    onError: (e: any) =>
      toast({ title: "Create failed", description: e.message, variant: "destructive" }),
  });

  const renameGroupMut = useMutation({
    mutationFn: async ({ groupId, name }: { groupId: string; name: string }) => {
      const res = await fetch(`/api/clickup/groups/${groupId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/api/clickup/workspaces/${workspaceId}/groups`],
      }); // fire-and-forget: cache refresh only
      setEditingGroup(null);
      toast({ title: "Group renamed" });
    },
    onError: (e: any) =>
      toast({ title: "Rename failed", description: e.message, variant: "destructive" }),
  });

  const deleteGroupMut = useMutation({
    mutationFn: async (groupId: string) => {
      const res = await fetch(`/api/clickup/groups/${groupId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error((d as any).error ?? `HTTP ${res.status}`);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [`/api/clickup/workspaces/${workspaceId}/groups`],
      }); // fire-and-forget: cache refresh only
      setDeletingGroupId(null);
      toast({ title: "Group deleted" });
    },
    onError: (e: any) =>
      toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const plan = planQ.data?.plan ?? "";
  const memberSeats = seatsQ.data?.members;
  const guestSeats = seatsQ.data?.guests;

  return (
    <div className="space-y-4" data-testid="panel-people">
      {/* Plan & Seats banner */}
      <Card className="border-purple-100 bg-purple-50/40">
        <CardContent className="py-2 px-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Building className="w-3.5 h-3.5 text-purple-500" />
            <span className="text-xs font-medium text-purple-700" data-testid="plan-name">
              {planQ.isLoading
                ? "Loading plan…"
                : plan
                  ? `${plan} plan`
                  : "Plan not available"}
            </span>
          </div>
          {memberSeats && (
            <span className="text-xs text-gray-600" data-testid="member-seats">
              Members: {memberSeats.filled ?? memberSeats.used ?? "?"}/
              {memberSeats.total ?? "?"}
            </span>
          )}
          {guestSeats && (
            <span className="text-xs text-gray-600" data-testid="guest-seats">
              Guests: {guestSeats.filled ?? guestSeats.used ?? "?"}/
              {guestSeats.total ?? "?"}
            </span>
          )}
          {plan && (
            <Badge
              variant="outline"
              className={`text-[9px] px-1.5 py-0 ml-auto ${
                plan.toLowerCase().includes("enterprise")
                  ? "border-amber-300 text-amber-700 bg-amber-50"
                  : plan.toLowerCase().includes("business")
                    ? "border-purple-300 text-purple-700 bg-purple-50"
                    : "border-gray-200 text-gray-600"
              }`}
              data-testid="plan-badge"
            >
              {plan}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Section tabs */}
      <div className="flex gap-1">
        {(["members", "roles", "groups"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setActiveSection(s)}
            data-testid={`people-section-${s}`}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              activeSection === s
                ? "bg-purple-100 border-purple-300 text-purple-700 font-medium"
                : "border-gray-200 text-gray-500 hover:border-gray-300"
            }`}
          >
            {s === "members" ? "Members" : s === "roles" ? "Custom Roles" : "User Groups"}
          </button>
        ))}
      </div>

      {/* Members section */}
      {activeSection === "members" && (
        <div className="space-y-2" data-testid="section-members">
          <p className="text-xs text-amber-600 flex items-start gap-1 leading-tight">
            <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
            Seat usage is displayed in the plan banner above. To see who has explicit access
            to a specific task or list, open that item and use the{" "}
            <strong>Access</strong> tab.
          </p>
          <div className="rounded-md border border-gray-100 bg-gray-50 p-3 text-xs text-gray-500 space-y-1">
            <p>
              Enterprise-level user administration (invite, remove, role assignment) is
              available only in ClickUp's workspace settings and is not exposed via the
              ClickUp API.
            </p>
          </div>
        </div>
      )}

      {/* Custom Roles section */}
      {activeSection === "roles" && (
        <div className="space-y-2" data-testid="section-roles">
          {rolesQ.isLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-xs py-4 justify-center">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading roles…
            </div>
          ) : rolesQ.isError ? (
            <p className="text-xs text-red-500">Failed to load custom roles.</p>
          ) : (rolesQ.data?.roles ?? []).length === 0 ? (
            <div className="text-center py-6 text-gray-400">
              <Shield className="w-5 h-5 mx-auto mb-1 opacity-50" />
              <p className="text-xs">No custom roles defined for this workspace.</p>
            </div>
          ) : (
            <div className="space-y-0">
              {(rolesQ.data?.roles ?? []).map((role: any) => (
                <div
                  key={role.id}
                  className="flex items-center gap-2 text-xs py-2 border-b last:border-b-0"
                  data-testid={`role-row-${role.id}`}
                >
                  <Shield className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-gray-700 truncate">{role.name}</div>
                    {role.permissions && (
                      <div className="text-[10px] text-gray-400 truncate">
                        {Array.isArray(role.permissions)
                          ? role.permissions.join(", ")
                          : JSON.stringify(role.permissions)}
                      </div>
                    )}
                  </div>
                  {role.custom && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0">
                      custom
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-[10px] text-gray-400 italic pt-1">
            Custom roles are managed in ClickUp's workspace settings. Role editing is not
            available via the API.
          </p>
        </div>
      )}

      {/* User Groups section */}
      {activeSection === "groups" && (
        <div className="space-y-3" data-testid="section-groups">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              User groups pool workspace members for easy assignment.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setShowCreateGroup(true);
                setGroupName("");
              }}
              className="h-6 text-xs px-2"
              data-testid="button-create-group"
            >
              <Plus className="w-3 h-3 mr-1" /> New Group
            </Button>
          </div>

          {showCreateGroup && (
            <div className="rounded-md border border-purple-200 bg-purple-50/30 p-3 space-y-2">
              <Label className="text-xs">Group name</Label>
              <div className="flex gap-2">
                <Input
                  className="h-7 text-xs flex-1"
                  placeholder="e.g. Design team"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && groupName.trim())
                      createGroupMut.mutate(groupName.trim());
                    if (e.key === "Escape") setShowCreateGroup(false);
                  }}
                  autoFocus
                  data-testid="input-group-name"
                />
                <Button
                  size="sm"
                  className="h-7 text-xs px-3"
                  disabled={!groupName.trim() || createGroupMut.isPending}
                  onClick={() => createGroupMut.mutate(groupName.trim())}
                  data-testid="button-save-group"
                >
                  {createGroupMut.isPending ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    "Create"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs px-2"
                  onClick={() => setShowCreateGroup(false)}
                >
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
          )}

          {groupsQ.isLoading ? (
            <div className="flex items-center gap-2 text-gray-400 text-xs py-4 justify-center">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading groups…
            </div>
          ) : groupsQ.isError ? (
            <p className="text-xs text-red-500">Failed to load user groups.</p>
          ) : (groupsQ.data?.groups ?? []).length === 0 ? (
            <div className="text-center py-6 text-gray-400">
              <Users className="w-5 h-5 mx-auto mb-1 opacity-50" />
              <p className="text-xs">No user groups yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="space-y-0">
              {(groupsQ.data?.groups ?? []).map((group: any) => (
                <div
                  key={group.id}
                  className="flex items-center gap-2 text-xs py-2 border-b last:border-b-0"
                  data-testid={`group-row-${group.id}`}
                >
                  <Users className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                  {editingGroup?.id === group.id ? (
                    <div className="flex-1 flex gap-1">
                      <Input
                        className="h-6 text-xs flex-1"
                        value={groupName}
                        onChange={(e) => setGroupName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && groupName.trim())
                            renameGroupMut.mutate({
                              groupId: group.id,
                              name: groupName.trim(),
                            });
                          if (e.key === "Escape") setEditingGroup(null);
                        }}
                        autoFocus
                      />
                      <Button
                        size="sm"
                        className="h-6 text-xs px-2"
                        disabled={!groupName.trim() || renameGroupMut.isPending}
                        onClick={() =>
                          renameGroupMut.mutate({
                            groupId: group.id,
                            name: groupName.trim(),
                          })
                        }
                      >
                        {renameGroupMut.isPending ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          "Save"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs px-1"
                        onClick={() => setEditingGroup(null)}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-700 truncate">
                          {group.name}
                        </div>
                        {Array.isArray(group.members) && (
                          <div className="text-[10px] text-gray-400">
                            {group.members.length} member
                            {group.members.length !== 1 ? "s" : ""}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 ml-auto">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 w-5 p-0 text-gray-400 hover:text-gray-600"
                          onClick={() => {
                            setEditingGroup(group);
                            setGroupName(group.name);
                          }}
                          data-testid={`button-rename-group-${group.id}`}
                        >
                          <Pencil className="w-2.5 h-2.5" />
                        </Button>
                        {deletingGroupId === group.id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-red-600">Sure?</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 text-[10px] px-1 text-red-600"
                              disabled={deleteGroupMut.isPending}
                              onClick={() => deleteGroupMut.mutate(group.id)}
                            >
                              {deleteGroupMut.isPending ? (
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                              ) : (
                                "Yes"
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-5 text-[10px] px-1"
                              onClick={() => setDeletingGroupId(null)}
                            >
                              No
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 w-5 p-0 text-gray-400 hover:text-red-500"
                            onClick={() => setDeletingGroupId(group.id)}
                            data-testid={`button-delete-group-${group.id}`}
                          >
                            <Trash2 className="w-2.5 h-2.5" />
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

